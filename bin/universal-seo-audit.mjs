#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const version = "1.0.1";

function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function printHelp() {
  console.log(`universal-seo-audit

Usage:
  universal-seo-audit <command> [options]

Commands:
  audit               Full workflow: build URLs, scan, summary, ticket backlog
  build-urls          Build a URL list from sitemap discovery
  scan                Run the raw SEO scan from a URL list or crawl mode
  report              Generate docs-ready markdown summary
  tickets             Generate ticket/backlog CSV
  compare             Compare two previous runs
  lighthouse          Show Lighthouse usage note
  sitemap-xml-to-urls Convert browser-saved sitemap XML to urls.txt
  help                Show this help
  version             Show package version
`);
}

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "audit";
const rest = command === "audit" ? (argv[0] === "audit" ? argv.slice(1) : argv) : argv.slice(1);

switch (command) {
  case "audit": run("run-seo-audit.mjs", rest); break;
  case "build-urls": run("build-urls-from-sitemap.mjs", rest); break;
  case "scan": run("seo-audit.mjs", rest); break;
  case "report": run("generate-seo-report.mjs", rest); break;
  case "tickets": run("generate-seo-tickets.mjs", rest); break;
  case "compare": run("compare-seo-runs.mjs", rest); break;
  case "lighthouse": console.log("Use --lighthouse with the audit command to run a real Lighthouse performance pass per page."); break;
  case "sitemap-xml-to-urls": run("convert-sitemap-xml-to-urls.mjs", rest); break;
  case "help": case "--help": case "-h": printHelp(); break;
  case "version": case "--version": case "-v": console.log(version); break;
  default: console.error(`Unknown command: ${command}`); printHelp(); process.exit(1);
}
