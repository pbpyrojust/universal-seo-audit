#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.replace(/^--/, "");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}
function slugifySite(site) {
  if (!site) return "site";
  try {
    const url = new URL(site);
    const host = (url.hostname || site).replace(/^www\./, "").toLowerCase();
    return host.replace(/[^a-z0-9.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "") || "site";
  } catch {
    return String(site || "site").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "") || "site";
  }
}
function getRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function run(script, args) {
  return spawnSync(process.execPath, [path.resolve("scripts", script), ...args], { stdio: "inherit", env: process.env });
}

const args = parseArgs(process.argv);
const site = args.site;
const runId = args["run-id"] || `${slugifySite(site || args["sitemap-url"] || "site")}-${getRunId()}`;
const baseOutDir = path.resolve(process.cwd(), args["out-dir"] || "reports");
const outDir = path.join(baseOutDir, runId);
fs.mkdirSync(outDir, { recursive: true });
const urlsFile = args["urls-file"] ? path.resolve(args["urls-file"]) : path.join(outDir, "urls.txt");
const batchSize = args["batch-size"] ? Number(args["batch-size"]) : 0;

if (batchSize > 0) console.log(`\nℹ Small-batch mode enabled (--batch-size ${batchSize}).`);
if (args["slow"] || args["cloudflare-aware"]) {
  console.log("\nℹ Protected-site / conservative mode enabled.");
  console.log("ℹ Heartbeat progress lines will appear on long navigation or analysis steps so the scan does not look stalled.");
}
if (args["http-username"] || args["auth-config"] || (args["login-url"] && args["username"])) {
  console.log("ℹ Authentication options detected. This run will attempt protected-site access before scanning.");
}

if (!args["urls-file"]) {
  console.log("\n=== Step 1/4: Build URL list from sitemap ===");
  const buildArgs = ["--out", urlsFile];
  for (const key of ["site","sitemap-url","include-sitemaps"]) {
    if (args[key]) buildArgs.push(`--${key}`, args[key]);
  }
  if (args["include-all-sitemaps"]) buildArgs.push("--include-all-sitemaps");
  const res = run("build-urls-from-sitemap.mjs", buildArgs);
  if (res.status !== 0) process.exit(res.status || 1);
} else {
  console.log("\n=== Step 1/4: Using provided URL file ===");
  console.log(`Using URLs file: ${urlsFile}`);
}

if (batchSize > 0) {
  try {
    const raw = fs.readFileSync(urlsFile, "utf8");
    const urls = raw.split(/\r?\n/g).map((s) => s.trim()).filter(Boolean);
    if (urls.length > batchSize) {
      fs.writeFileSync(urlsFile, urls.slice(0, batchSize).join("\n") + "\n", "utf8");
      console.log(`ℹ --batch-size enabled. Trimmed URL list from ${urls.length} to ${batchSize} URL(s) for this run.`);
    }
  } catch {}
}

console.log("\n=== Step 2/4: Run SEO audit ===");
const auditArgs = ["--urls-file", urlsFile, "--out-dir", baseOutDir, "--run-id", runId];
if (site) auditArgs.push("--start", site);
for (const key of ["slow","respect-robots","cloudflare-aware","crawl","http-username","http-password","auth-config","login-url","username","password","username-selector","password-selector","submit-selector","ready-selector","post-login-wait-ms"]) {
  if (args[key] === true) auditArgs.push(`--${key}`);
  else if (args[key]) auditArgs.push(`--${key}`, String(args[key]));
}
for (const key of ["retries","backoff-ms","crawl-delay-ms","max-link-checks"]) {
  if (args[key]) auditArgs.push(`--${key}`, String(args[key]));
}
if (batchSize > 0) auditArgs.push("--batch-size", String(batchSize));
const a = run("seo-audit.mjs", auditArgs);
if (a.status !== 0) process.exit(a.status || 1);

console.log("\n=== Step 3/4: Generate SEO summary report ===");
const rep = ["--run-dir", outDir];
if (site) rep.push("--site", site);
run("generate-seo-report.mjs", rep);

console.log("\n=== Step 4/4: Generate SEO ticket/backlog CSV ===");
run("generate-seo-tickets.mjs", ["--run-dir", outDir]);
console.log(`\nRun folder: ${outDir}`);
