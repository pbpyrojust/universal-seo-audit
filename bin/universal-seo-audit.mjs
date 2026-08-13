#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function run(script, args) {
  const scriptPath = path.join(root, 'scripts', script);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function printHelp() {
  console.log(`universal-seo-audit

Usage:
  universal-seo-audit <command> [options]

Commands:
  audit                 Full technical SEO audit workflow
  quick                 Fast top-level audit preset: no Lighthouse, top-level URLs, capped page count
  lite                  Low-memory audit preset: no Lighthouse, capped page/crawl scope
  build-urls            Build a URL list from sitemap discovery
  report                Generate a text summary report from an existing run
  tickets               Generate ticket/backlog CSV items from audit findings
  visual-report         Generate the branded HTML dashboard + PDF report
  compare               Compare two completed SEO audit runs
  sitemap-xml-to-urls   Convert a browser-saved sitemap XML file into urls.txt
  help                  Show this help
  version               Show package version

Examples:
  universal-seo-audit quick --site https://www.example.com
  universal-seo-audit audit --site https://www.example.com
  universal-seo-audit audit --site https://www.example.com --lighthouse
  universal-seo-audit audit --site https://www.example.com --top-level
  universal-seo-audit lite --site https://www.example.com --crawl
  universal-seo-audit audit --site https://www.example.com --slow --respect-robots --cloudflare-aware
  universal-seo-audit audit --site https://www.example.com --brand-config ./branding.json
  universal-seo-audit build-urls --site https://www.example.com --out ./reports/urls.txt
  universal-seo-audit report --run-dir ./reports/<run-id> --site https://www.example.com
  universal-seo-audit tickets --run-dir ./reports/<run-id>
  universal-seo-audit visual-report --run-dir ./reports/<run-id> --site https://www.example.com --brand-config ./branding.json
  universal-seo-audit compare --before ./reports/run-a --after ./reports/run-b
  universal-seo-audit sitemap-xml-to-urls --input ./saved-sitemap.xml --out ./reports/urls.txt
  universal-seo-audit audit --site https://staging.example.com --auth-config ./auth.local.json

Primary outputs:
  seo-pages.csv                 Per-page SEO metadata and status data
  seo-assets.csv                Asset integrity inventory
  seo-issues.csv                Findings with severity and details
  seo-images.csv                Image alt text inventory
  seo-social.csv                Open Graph and Twitter Card metadata
  seo-structured-data.csv       Schema, canonical, hreflang, and DOM data
  seo-crawl-analysis.csv        Internal link depth, inlinks, and orphan candidates
  seo-scripts.csv               Script inventory and CSP readiness data
  seo-agentic.csv               Browser-agent readiness signals
  seo-lighthouse.csv            Lighthouse scores when enabled
  seo-report.json               Combined JSON report
  seo-run-metadata.json         Run summary and timing data
  seo-dashboard.html            Visual HTML dashboard
  seo-dashboard.pdf             PDF version of the dashboard

If no command is provided, the CLI defaults to 'audit'.
`);
}

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'audit';
const rest = command === 'audit' ? (argv[0] === 'audit' ? argv.slice(1) : argv) : argv.slice(1);

switch (command) {
  case 'audit':
    run('run-seo-audit.mjs', rest);
    break;
  case 'quick':
    run('run-seo-audit.mjs', ['--quick', ...rest]);
    break;
  case 'lite':
    run('run-seo-audit.mjs', ['--lite', ...rest]);
    break;
  case 'build-urls':
    run('build-urls-from-sitemap.mjs', rest);
    break;
  case 'report':
    run('generate-seo-report.mjs', rest);
    break;
  case 'tickets':
    run('generate-seo-tickets.mjs', rest);
    break;
  case 'visual-report':
    run('generate-visual-report.mjs', rest);
    break;
  case 'compare':
    run('compare-seo-runs.mjs', rest);
    break;
  case 'sitemap-xml-to-urls':
    run('convert-sitemap-xml-to-urls.mjs', rest);
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(pkg.version);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
