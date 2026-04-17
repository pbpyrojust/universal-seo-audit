#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}
function parseCsv(csvText) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { if (!(row.length === 1 && row[0] === "")) rows.push(row); row = []; };
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') { if (csvText[i+1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { pushField(); continue; }
    if (ch === '\n') { pushField(); pushRow(); continue; }
    if (ch === '\r') { if (csvText[i+1] === '\n') i++; pushField(); pushRow(); continue; }
    field += ch;
  }
  pushField(); pushRow();
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? ""])));
}
const args = parseArgs(process.argv);
const runDir = args["run-dir"];
if (!runDir) { console.error("ERROR: Missing --run-dir"); process.exit(1); }
const site = args.site || "the site";
const issues = parseCsv(fs.readFileSync(path.join(runDir, "seo-issues.csv"), "utf8"));
const pages = parseCsv(fs.readFileSync(path.join(runDir, "seo-pages.csv"), "utf8"));
const meta = JSON.parse(fs.readFileSync(path.join(runDir, "seo-run-metadata.json"), "utf8"));
const count = (k) => issues.filter((r) => r.issue_type === k).length;
const topIssueTypes = Object.entries(issues.reduce((acc, r) => { acc[r.issue_type] = (acc[r.issue_type] || 0) + 1; return acc; }, {})).sort((a,b)=>b[1]-a[1]).slice(0, 12);
const out = [];
out.push("# SEO Audit Summary");
out.push("");
out.push(`Site: ${site}`);
out.push(`Pages scanned: ${meta.pagesScanned || pages.length}`);
out.push(`Issues found: ${meta.issuesFound || issues.length}`);
out.push("");
out.push("## Executive summary");
out.push("This phase 2 SEO audit checks core technical and on-page SEO signals for development, staging, protected, and noindex environments. In addition to metadata, canonical, robots, and heading checks, phase 2 also surfaces broken links, duplicate metadata patterns, image alt issues, and thin-content signals so teams can prioritize remediation before launch.");
out.push("");
out.push("## Highest-priority findings");
out.push(`- Broken/error pages: ${count("http_4xx") + count("http_5xx")}`);
out.push(`- Broken internal links: ${count("broken_internal_link")}`);
out.push(`- Missing titles: ${count("missing_title")}`);
out.push(`- Duplicate titles: ${count("duplicate_title")}`);
out.push(`- Missing canonicals: ${count("canonical_missing")}`);
out.push(`- Missing H1s: ${count("h1_missing")}`);
out.push("");
out.push("## Phase 2 additions");
out.push(`- Duplicate title detection: ${count("duplicate_title")}`);
out.push(`- Duplicate meta description detection: ${count("duplicate_meta_description")}`);
out.push(`- Broken external links: ${count("broken_external_link")}`);
out.push(`- Thin content flags: ${count("thin_content")}`);
out.push(`- Missing image alt flags: ${count("image_alt_missing")}`);
out.push(`- Filename-style image alt flags: ${count("image_alt_filename")}`);
out.push("");
out.push("## Priority order");
out.push("1. Fix HTTP 4xx/5xx pages and broken internal links");
out.push("2. Fix missing/duplicate titles and canonical problems");
out.push("3. Fix missing H1s and thin-content pages");
out.push("4. Clean up duplicate meta descriptions, noindex/nofollow directives, and image alt issues");
out.push("");
out.push("## Top issue types");
for (const [issue, n] of topIssueTypes) out.push(`- ${issue}: ${n}`);
out.push("");
out.push("## Example problem pages");
for (const row of issues.slice(0, 20)) out.push(`- ${row.page_url} — ${row.issue_type} — ${row.details}`);
out.push("");
out.push("## Output files");
out.push("- seo-pages.csv");
out.push("- seo-issues.csv");
out.push("- seo-images.csv");
out.push("- seo-ticket-backlog.csv");
out.push("- seo-report.json");
const outPath = path.join(runDir, "seo-summary-google-doc.md");
fs.writeFileSync(outPath, out.join("\n"), "utf8");
console.log(`Wrote: ${outPath}`);
