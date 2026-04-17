#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
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
    if (ch === '
') { pushField(); pushRow(); continue; }
    if (ch === '') { if (csvText[i+1] === '
') i++; pushField(); pushRow(); continue; }
    field += ch;
  }
  pushField(); pushRow();
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? ""])));
}
function esc(s){ s=String(s??""); return /[",
]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }
function writeCsv(rows, columns, outPath){ const body=[columns.join(","), ...rows.map((r)=>columns.map((c)=>esc(r[c])).join(","))].join("
")+"
"; fs.writeFileSync(outPath, body, "utf8"); }
const args = parseArgs(process.argv);
if (!args.before || !args.after) {
  console.error("Usage: node scripts/compare-seo-runs.mjs --before reports/run-a --after reports/run-b");
  process.exit(1);
}
const beforeDir = path.resolve(process.cwd(), args.before);
const afterDir = path.resolve(process.cwd(), args.after);
const outDir = args["out-dir"] ? path.resolve(process.cwd(), args["out-dir"]) : afterDir;
const beforeIssues = parseCsv(fs.readFileSync(path.join(beforeDir, "seo-issues.csv"), "utf8"));
const afterIssues = parseCsv(fs.readFileSync(path.join(afterDir, "seo-issues.csv"), "utf8"));
const key = (r) => `${r.page_url}__${r.issue_type}__${r.details}`;
const beforeMap = new Map(beforeIssues.map((r)=>[key(r), r]));
const afterMap = new Map(afterIssues.map((r)=>[key(r), r]));
const newIssues = afterIssues.filter((r)=>!beforeMap.has(key(r)));
const resolvedIssues = beforeIssues.filter((r)=>!afterMap.has(key(r)));
const unchangedIssues = afterIssues.filter((r)=>beforeMap.has(key(r)));
const issueCountsBefore = beforeIssues.reduce((acc,r)=>{acc[r.issue_type]=(acc[r.issue_type]||0)+1; return acc;}, {});
const issueCountsAfter = afterIssues.reduce((acc,r)=>{acc[r.issue_type]=(acc[r.issue_type]||0)+1; return acc;}, {});
const issueTypes = [...new Set([...Object.keys(issueCountsBefore), ...Object.keys(issueCountsAfter)])].sort();
const summaryRows = issueTypes.map((issue_type)=>({ issue_type, before_count: issueCountsBefore[issue_type] || 0, after_count: issueCountsAfter[issue_type] || 0, delta: (issueCountsAfter[issue_type] || 0) - (issueCountsBefore[issue_type] || 0) }));
writeCsv(summaryRows, ["issue_type","before_count","after_count","delta"], path.join(outDir, "seo-compare-summary.csv"));
writeCsv(newIssues, Object.keys(newIssues[0] || { page_url:"", issue_type:"", details:"" }), path.join(outDir, "seo-compare-new-issues.csv"));
writeCsv(resolvedIssues, Object.keys(resolvedIssues[0] || { page_url:"", issue_type:"", details:"" }), path.join(outDir, "seo-compare-resolved-issues.csv"));
const md = ["# SEO Run Comparison","",`Before: ${beforeDir}`,`After: ${afterDir}`,"",`New issues: ${newIssues.length}`,`Resolved issues: ${resolvedIssues.length}`,`Unchanged issues: ${unchangedIssues.length}`,"","## Issue type deltas",...summaryRows.map((r)=>`- ${r.issue_type}: ${r.before_count} -> ${r.after_count} (${r.delta >= 0 ? "+" : ""}${r.delta})`),"","## New issues",...newIssues.slice(0,20).map((r)=>`- ${r.page_url} — ${r.issue_type} — ${r.details}`),"","## Resolved issues",...resolvedIssues.slice(0,20).map((r)=>`- ${r.page_url} — ${r.issue_type} — ${r.details}`)];
fs.writeFileSync(path.join(outDir, "seo-compare-summary.md"), md.join("
"), "utf8");
console.log(`Wrote: ${path.join(outDir, "seo-compare-summary.csv")}`);
console.log(`Wrote: ${path.join(outDir, "seo-compare-new-issues.csv")}`);
console.log(`Wrote: ${path.join(outDir, "seo-compare-resolved-issues.csv")}`);
console.log(`Wrote: ${path.join(outDir, "seo-compare-summary.md")}`);
