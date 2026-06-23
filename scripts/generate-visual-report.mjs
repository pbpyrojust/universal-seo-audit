#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.replace(/^--/, '');
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}
function parseCsv(csvText) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { if (!(row.length === 1 && row[0] === '')) rows.push(row); row = []; };
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
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? ''])));
}
function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function loadCsv(runDir, name) {
  const p = path.join(runDir, name);
  return fs.existsSync(p) ? parseCsv(fs.readFileSync(p, 'utf8')) : [];
}
const args = parseArgs(process.argv);
const runDir = args['run-dir'];
if (!runDir) { console.error('ERROR: Missing --run-dir'); process.exit(1); }
const site = args.site || 'the site';
let branding = {
  companyName: 'Universal SEO Audit',
  primaryColor: '#2563eb',
  secondaryColor: '#111827',
  accentColor: '#22c55e',
  reportTitle: 'Technical SEO & Site Health Audit',
  author: 'Universal SEO Audit',
  footerText: 'Confidential report'
};
if (args['brand-config']) {
  try { branding = { ...branding, ...JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args['brand-config']), 'utf8')) }; }
  catch (e) { console.warn('Warning: failed to load brand config:', String(e?.message || e)); }
}
const pages = loadCsv(runDir, 'seo-pages.csv');
const issues = loadCsv(runDir, 'seo-issues.csv');
const assets = loadCsv(runDir, 'seo-assets.csv');
const sections = loadCsv(runDir, 'seo-section-summary.csv');
const hosts = loadCsv(runDir, 'seo-asset-host-summary.csv');
const lh = loadCsv(runDir, 'seo-lighthouse.csv');
const agentic = loadCsv(runDir, 'seo-agentic.csv');
const scripts = loadCsv(runDir, 'seo-scripts.csv');
const cspSummary = loadCsv(runDir, 'seo-csp-summary.csv');
const brokenAssets = assets.filter((a) => a.broken === 'yes').length;
const wwwMismatches = assets.filter((a) => a.www_mismatch === 'yes').length;
const hostMismatches = assets.filter((a) => a.host_mismatch === 'yes').length;
const stageMixups = assets.filter((a) => a.staging_production_mixup === 'yes').length;
const missingCanonicals = pages.filter((p) => p.canonical_status === 'missing').length;
const duplicateCanonicals = pages.filter((p) => Number(p.canonical_count || 0) > 1 || p.canonical_status === 'multiple').length;
const hreflangMissing = pages.filter((p) => p.hreflang_present === 'no').length;
const hreflangInvalid = pages.filter((p) => Number(p.hreflang_invalid_count || 0) > 0 || Number(p.hreflang_duplicate_count || 0) > 0).length;
const issueCounts = {};
for (const i of issues) issueCounts[i.issue_type] = (issueCounts[i.issue_type] || 0) + 1;
const topIssues = Object.entries(issueCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);
const avgPerf = lh.length ? (lh.reduce((a,r)=>a+num(r.performance),0)/lh.length).toFixed(1) : '—';
const avgAgentic = agentic.length ? (agentic.reduce((a,r)=>a+num(r.agentic_score),0)/agentic.length).toFixed(1) : '—';
const avgWebMcp = agentic.length ? (agentic.reduce((a,r)=>a+num(r.webmcp_protocol_score),0)/agentic.length).toFixed(1) : '—';
const llmsPresent = agentic.filter((r)=>r.llms_txt_present === 'yes').length;
const agenticHtml = `<div class="section card"><h2>Agentic readiness</h2><table class="table"><thead><tr><th>Page</th><th>Agentic</th><th>WebMCP</th><th>Accessibility tree</th><th>llms.txt</th><th>Layout stability</th></tr></thead><tbody>${agentic.slice(0,20).map((r)=>`<tr><td>${esc(r.page_url)}</td><td>${esc(r.agentic_score)} (${esc(r.agentic_grade)})</td><td>${esc(r.webmcp_protocol_score)}</td><td>${esc(r.accessibility_tree_score)}</td><td>${esc(r.llms_txt_present)} ${esc(r.llms_txt_status || '')}</td><td>${esc(r.layout_stability_score)}</td></tr>`).join('') || '<tr><td colspan="6">No agentic readiness data found.</td></tr>'}</tbody></table></div>`;
const csp = cspSummary[0] || {};
const totalScripts = scripts.reduce((a,r)=>a+num(r.total_script_count),0);
const totalExtScripts = scripts.reduce((a,r)=>a+num(r.external_script_count),0);
const totalInlScripts = scripts.reduce((a,r)=>a+num(r.inline_script_count),0);
const totalHandlers = scripts.reduce((a,r)=>a+num(r.inline_event_handler_count),0);
const totalRenderBlock = scripts.reduce((a,r)=>a+num(r.render_blocking_script_count),0);
const thirdPartyDomains = csp.third_party_domains ? csp.third_party_domains.split(' | ').filter(Boolean) : [];
const scriptPerPageHtml = scripts.length ? scripts.slice(0,20).map((r)=>`<tr><td>${esc(r.page_url)}</td><td>${esc(r.external_script_count)}</td><td>${esc(r.inline_script_count)}</td><td>${esc(r.total_script_count)}</td><td>${esc(r.third_party_script_count)}</td><td>${esc(r.inline_event_handler_count)}</td><td>${num(r.render_blocking_script_count) > 0 ? '<span style="color:#dc2626">'+esc(r.render_blocking_script_count)+'</span>' : '0'}</td><td>${r.needs_unsafe_inline==='yes' ? '<span style="color:#dc2626">yes</span>' : 'no'}</td></tr>`).join('') : '<tr><td colspan="8">No script data found.</td></tr>';
const cspDomainsHtml = thirdPartyDomains.length ? thirdPartyDomains.map((d)=>`<tr><td>${esc(d)}</td></tr>`).join('') : '<tr><td>No third-party script domains detected.</td></tr>';
const scriptsHtml = `<div class="section card"><h2>Script audit &amp; CSP readiness</h2><div class="grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px"><div class="card" style="padding:12px"><div class="sub">Total scripts</div><div class="metric" style="font-size:28px">${totalScripts}</div><div class="sub">${totalExtScripts} external · ${totalInlScripts} inline</div></div><div class="card" style="padding:12px"><div class="sub">Render-blocking</div><div class="metric" style="font-size:28px;${totalRenderBlock>0?'color:#dc2626':''}">${totalRenderBlock}</div></div><div class="card" style="padding:12px"><div class="sub">Inline handlers</div><div class="metric" style="font-size:28px;${totalHandlers>5?'color:#dc2626':''}">${totalHandlers}</div></div><div class="card" style="padding:12px"><div class="sub">3rd-party domains</div><div class="metric" style="font-size:28px">${thirdPartyDomains.length}</div></div></div><div class="two"><div><h3 style="margin:0 0 8px;font-size:16px">Scripts per page</h3><table class="table"><thead><tr><th>Page</th><th>Ext</th><th>Inline</th><th>Total</th><th>3P</th><th>Handlers</th><th>Blocking</th><th>Unsafe</th></tr></thead><tbody>${scriptPerPageHtml}</tbody></table></div><div><h3 style="margin:0 0 8px;font-size:16px">Third-party script domains</h3><table class="table"><thead><tr><th>Domain</th></tr></thead><tbody>${cspDomainsHtml}</tbody></table>${csp.suggested_script_src ? `<h3 style="margin:16px 0 8px;font-size:16px">Suggested CSP script-src</h3><code style="display:block;background:#f1f5f9;padding:12px;border-radius:8px;font-size:12px;word-break:break-all;line-height:1.5">${esc(csp.suggested_script_src)}</code>` : ''}<div style="margin-top:12px;font-size:13px;color:var(--muted)">${csp.needs_unsafe_inline==='yes' ? '<span style="color:#dc2626">⚠ Requires unsafe-inline — add nonces to inline scripts to remove this.</span><br>' : '<span style="color:#16a34a">✓ No unsafe-inline needed.</span><br>'}${csp.needs_unsafe_eval==='yes' ? '<span style="color:#dc2626">⚠ Requires unsafe-eval — refactor eval() usage on '+esc(csp.pages_with_eval)+' page(s).</span>' : '<span style="color:#16a34a">✓ No unsafe-eval needed.</span>'}</div></div></div></div>`;
const logoHtml = branding.logo ? `<img src="${esc(branding.logo)}" alt="${esc(branding.companyName)} logo" style="max-height:56px; max-width:220px; object-fit:contain; display:block; margin-bottom:12px;">` : '';
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${esc(branding.reportTitle)}</title><style>:root{--primary:${branding.primaryColor};--secondary:${branding.secondaryColor};--accent:${branding.accentColor};--bg:#f8fafc;--panel:#ffffff;--muted:#64748b;--border:#cbd5e1}body{font-family:Inter,Arial,sans-serif;margin:0;background:var(--bg);color:var(--secondary)}.wrap{max-width:1180px;margin:0 auto;padding:32px}.header{background:linear-gradient(135deg,var(--primary),var(--secondary));color:white;padding:28px;border-radius:18px;box-shadow:0 10px 30px rgba(15,23,42,.18)}.header h1{margin:0 0 8px;font-size:32px;line-height:1.1}.header p{margin:4px 0 0;color:#dbeafe}.meta{margin-top:8px;font-size:13px;color:#e2e8f0}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:24px 0}.two{display:grid;grid-template-columns:1fr 1fr;gap:20px}.section{margin-top:24px}.card{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:20px;box-shadow:0 6px 20px rgba(15,23,42,.06)}.card h2{margin:0 0 12px;font-size:20px}.metric{font-size:34px;font-weight:700;color:var(--primary)}.sub{color:var(--muted);font-size:13px}.table{width:100%;border-collapse:collapse;margin-top:8px}.table th,.table td{border-bottom:1px solid var(--border);padding:10px;text-align:left;font-size:14px;vertical-align:top}.table th{background:#f8fafc}.badge{display:inline-block;background:#f8fafc;border:1px solid var(--border);border-radius:999px;padding:4px 8px;font-size:12px}.footer{margin-top:24px;color:var(--muted);font-size:12px;text-align:center}@media print{body{background:#fff}.wrap{max-width:none;padding:0}.header{box-shadow:none}.card{box-shadow:none;break-inside:avoid-page}.grid,.two{break-inside:avoid}}</style></head><body><div class="wrap"><div class="header">${logoHtml}<h1>${esc(branding.reportTitle)}</h1><p>${esc(branding.companyName)}</p><div class="meta">Site: ${esc(site)} · Run folder: ${esc(runDir)} · Prepared by ${esc(branding.author || branding.companyName)}</div></div><div class="grid"><div class="card"><div class="sub">Pages scanned</div><div class="metric">${pages.length}</div></div><div class="card"><div class="sub">Total issues</div><div class="metric">${issues.length}</div></div><div class="card"><div class="sub">Assets checked</div><div class="metric">${assets.length}</div></div><div class="card"><div class="sub">Broken assets</div><div class="metric">${brokenAssets}</div></div><div class="card"><div class="sub">Missing canonicals</div><div class="metric">${missingCanonicals}</div></div><div class="card"><div class="sub">Duplicate canonicals</div><div class="metric">${duplicateCanonicals}</div></div><div class="card"><div class="sub">Missing hreflang</div><div class="metric">${hreflangMissing}</div></div><div class="card"><div class="sub">Invalid hreflang</div><div class="metric">${hreflangInvalid}</div></div><div class="card"><div class="sub">Agentic score</div><div class="metric">${avgAgentic}</div></div><div class="card"><div class="sub">WebMCP score</div><div class="metric">${avgWebMcp}</div></div><div class="card"><div class="sub">llms.txt present</div><div class="metric">${llmsPresent}</div></div><div class="card"><div class="sub">Lighthouse perf</div><div class="metric">${avgPerf}</div></div><div class="card"><div class="sub">Total scripts</div><div class="metric">${totalScripts}</div></div><div class="card"><div class="sub">3rd-party domains</div><div class="metric">${thirdPartyDomains.length}</div></div><div class="card"><div class="sub">Render-blocking</div><div class="metric">${totalRenderBlock}</div></div><div class="card"><div class="sub">Inline handlers</div><div class="metric">${totalHandlers}</div></div></div><div class="two section"><div class="card"><h2>Executive Summary</h2><p>This report summarizes technical SEO, canonical/hreflang coverage, asset integrity, script inventory, CSP readiness, and performance findings for ${esc(site)}.</p><p><strong>Immediate attention:</strong> broken assets, host mismatches, canonical conflicts, invalid hreflang, staging/production mixups, CSP blockers (unsafe-inline/eval), and low Lighthouse scores.</p></div><div class="card"><h2>Top issue types</h2><table class="table"><thead><tr><th>Issue</th><th>Count</th></tr></thead><tbody>${topIssues.map(([k,v])=>`<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2">No issues found.</td></tr>'}</tbody></table></div></div><div class="two section"><div class="card"><h2>Section summary</h2><table class="table"><thead><tr><th>Section</th><th>Pages</th><th>Assets</th><th>Issues</th></tr></thead><tbody>${sections.map((r)=>`<tr><td><span class="badge">${esc(r.section)}</span></td><td>${esc(r.page_count)}</td><td>${esc(r.asset_count)}</td><td>${esc(r.issue_count)}</td></tr>`).join('') || '<tr><td colspan="4">No section summary.</td></tr>'}</tbody></table></div><div class="card"><h2>Asset hosts</h2><table class="table"><thead><tr><th>Host</th><th>Count</th></tr></thead><tbody>${hosts.slice(0,15).map((r)=>`<tr><td>${esc(r.host)}</td><td>${esc(r.count)}</td></tr>`).join('') || '<tr><td colspan="2">No host summary.</td></tr>'}</tbody></table></div></div><div class="section card"><h2>Sample broken assets</h2><table class="table"><thead><tr><th>Page</th><th>Asset</th><th>Type</th><th>Status</th></tr></thead><tbody>${assets.filter((a)=>a.broken==='yes').slice(0,20).map((r)=>`<tr><td>${esc(r.page_url)}</td><td>${esc(r.asset_url)}</td><td>${esc(r.asset_type)}</td><td>${esc(r.status_code)}</td></tr>`).join('') || '<tr><td colspan="4">No broken assets found.</td></tr>'}</tbody></table></div><div class="section card"><h2>Canonical / hreflang examples</h2><table class="table"><thead><tr><th>Page</th><th>Canonical status</th><th>Canonical count</th><th>Hreflang count</th></tr></thead><tbody>${pages.filter((p)=>p.canonical_status!=='self_referencing' || p.hreflang_present==='no' || Number(p.hreflang_invalid_count||0)>0).slice(0,20).map((r)=>`<tr><td>${esc(r.page_url)}</td><td>${esc(r.canonical_status)}</td><td>${esc(r.canonical_count)}</td><td>${esc(r.hreflang_count)}</td></tr>`).join('') || '<tr><td colspan="4">No canonical/hreflang findings.</td></tr>'}</tbody></table></div>${agenticHtml}${scriptsHtml}<div class="footer">${esc(branding.footerText || '')}</div></div></body></html>`;
const htmlPath = path.join(runDir, 'seo-dashboard.html');
const pdfPath = path.join(runDir, 'seo-dashboard.pdf');
fs.writeFileSync(htmlPath, html, 'utf8');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('file://' + htmlPath, { waitUntil: 'load' });
await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' } });
await browser.close();
console.log(`Wrote: ${htmlPath}`);
console.log(`Wrote: ${pdfPath}`);
