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
function esc(s){ s = String(s ?? ""); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }
function writeCsv(rows, columns, outPath){ const body=[columns.join(","), ...rows.map((r)=>columns.map((c)=>esc(r[c])).join(","))].join("\n")+"\n"; fs.writeFileSync(outPath, body, "utf8"); }

const issueMeta = {
  http_4xx:{global:false}, http_5xx:{global:false}, broken_internal_link:{global:false}, broken_external_link:{global:false},
  missing_title:{global:true}, duplicate_title:{global:true}, title_too_long:{global:true}, title_too_short:{global:true},
  missing_meta_description:{global:true}, duplicate_meta_description:{global:true}, meta_description_too_long:{global:true}, meta_description_too_short:{global:true},
  canonical_missing:{global:true}, canonical_multiple:{global:true}, canonical_cross_domain:{global:false}, canonical_mismatch:{global:false},
  h1_missing:{global:true}, multiple_h1:{global:true}, noindex_present:{global:false}, nofollow_present:{global:false},
  redirect_page:{global:false}, thin_content:{global:false}, image_alt_missing:{global:false}, image_alt_filename:{global:false}, missing_lang:{global:true}, missing_viewport:{global:true}, invalid_jsonld:{global:false}, noindex_header:{global:false}, hreflang_invalid:{global:false}, heavy_dom:{global:false}, high_resource_count:{global:false}, missing_schema:{global:true}, schema_missing_type:{global:false}, og_title_missing:{global:true}, og_description_missing:{global:true}, og_image_missing:{global:true}, og_image_http:{global:false}, twitter_card_missing:{global:true}, twitter_image_missing:{global:false}, og_url_mismatch:{global:false}, invalid_schema_type:{global:false}, render_blocking_assets:{global:false}, slow_dom_interactive:{global:false}, duplicate_content_cluster:{global:false}, orphan_candidate:{global:false}, scan_error:{global:false}
};

const args = parseArgs(process.argv);
const runDir = args["run-dir"];
if (!runDir) { console.error("ERROR: Missing --run-dir"); process.exit(1); }
const issues = parseCsv(fs.readFileSync(path.join(runDir, "seo-issues.csv"), "utf8"));
const globals = new Map(), pages = new Map();

for (const issue of issues) {
  const meta = issueMeta[issue.issue_type] || { global: false };
  if (meta.global) {
    const key = `${issue.issue_type}__${issue.priority}`;
    const item = globals.get(key) || { ticket_type:"Global", issue_type:issue.issue_type, priority:issue.priority, importance:issue.importance, impact:issue.impact, pages:new Set(), occurrences:0 };
    item.pages.add(issue.page_url); item.occurrences += 1; globals.set(key, item);
  } else {
    const key = `${issue.page_url}__${issue.issue_type}__${issue.priority}`;
    const item = pages.get(key) || { ticket_type:"Page", issue_type:issue.issue_type, priority:issue.priority, importance:issue.importance, impact:issue.impact, page_url:issue.page_url, occurrences:0, details:issue.details, recommendation:issue.recommendation };
    item.occurrences += 1; pages.set(key, item);
  }
}

const rows = [];
for (const item of globals.values()) {
  const examplePages = [...item.pages].slice(0,5).join(" | ");
  rows.push({
    ticket_type:"Global", issue_type:item.issue_type, priority:item.priority, importance:item.importance, impact:item.impact, page_url:"",
    pages_affected:item.pages.size, occurrences:item.occurrences, example_pages:examplePages,
    ticket_title:`[SEO][${item.priority}] Fix ${item.issue_type} across site`,
    ticket_description:[`Type: Global`,`Issue: ${item.issue_type}`,`Priority: ${item.priority}`,`Importance: ${item.importance}`,`Pages affected: ${item.pages.size}`,`Occurrences: ${item.occurrences}`,`Example pages: ${examplePages}`,"",`Recommended action:`,`Fix this issue in shared templates/components where possible, then re-run the audit to confirm page-level fallout is reduced.`].join("\n"),
    ticket_labels:`seo, technical-seo, priority:${String(item.priority).toLowerCase()}, global`
  });
}
for (const item of pages.values()) {
  rows.push({
    ticket_type:"Page", issue_type:item.issue_type, priority:item.priority, importance:item.importance, impact:item.impact, page_url:item.page_url,
    pages_affected:1, occurrences:item.occurrences, example_pages:item.page_url,
    ticket_title:`[SEO][${item.priority}] Fix ${item.issue_type} on page`,
    ticket_description:[`Type: Page`,`Issue: ${item.issue_type}`,`Priority: ${item.priority}`,`Importance: ${item.importance}`,`Page: ${item.page_url}`,`Occurrences: ${item.occurrences}`,`Details: ${item.details}`,"",`Recommended action:`,item.recommendation].join("\n"),
    ticket_labels:`seo, technical-seo, priority:${String(item.priority).toLowerCase()}, page`
  });
}
const rank={"P0-Critical":0,"P1-High":1,"P2-Medium":2,"P3-Low":3};
rows.sort((a,b)=>{ if(a.ticket_type!==b.ticket_type) return a.ticket_type==="Global"?-1:1; return (rank[a.priority]??99)-(rank[b.priority]??99); });
writeCsv(rows, ["ticket_type","issue_type","priority","importance","impact","page_url","pages_affected","occurrences","example_pages","ticket_title","ticket_description","ticket_labels"], path.join(runDir, "seo-ticket-backlog.csv"));
console.log(`Wrote: ${path.join(runDir, "seo-ticket-backlog.csv")}`);
