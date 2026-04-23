#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { runLighthouseAudit } from './lib/lighthouse-runner.mjs';
import { checkAsset, classifyAssetType } from './lib/asset-checker.mjs';

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
function slugifySite(site) {
  try { return new URL(site).hostname.replace(/^www\./, ''); } catch { return 'site'; }
}
function runId(site) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${slugifySite(site)}-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  } catch { return String(u || '').trim(); }
}
function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
function getSection(urlStr) {
  try {
    const u = new URL(urlStr);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg || 'root';
  } catch { return 'unknown'; }
}
function escapeCsv(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function writeCsv(filePath, columns, rows) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeCsv(row[c])).join(','));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}
function extractCssUrls(cssText, baseUrl) {
  const urls = [];
  const re = /url\((.*?)\)/gim;
  let m;
  while ((m = re.exec(cssText))) {
    let raw = String(m[1] || '').trim().replace(/^['"]|['"]$/g, '');
    if (!raw || raw.startsWith('data:')) continue;
    try { urls.push(new URL(raw, baseUrl).toString()); } catch {}
  }
  return urls;
}

const args = parseArgs(process.argv);
if (!args.site) {
  console.error('Missing --site');
  process.exit(1);
}
const site = args.site;
const maxPages = Number(args['max-pages'] || 25);
const runLighthouse = Boolean(args['lighthouse']);
const outDir = path.resolve('reports/' + runId(site));
fs.mkdirSync(outDir, { recursive: true });

console.log('Running audit on:', site);
const origin = new URL(site).origin;
const canonicalHost = new URL(site).host;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const queue = [normalizeUrl(site)];
const seenPages = new Set();
const seenAssets = new Set();
const pageRows = [];
const assetRows = [];
const issueRows = [];
const lighthouseRows = [];
const sectionMap = new Map();
const hostMap = new Map();

while (queue.length && seenPages.size < maxPages) {
  const url = queue.shift();
  if (seenPages.has(url)) continue;
  seenPages.add(url);

  console.log('Scanning page:', url);
  let status = 0;
  try {
    const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
    status = res?.status?.() || 0;
  } catch {
    status = 0;
  }

  const data = await page.evaluate(() => {
    const assets = [];
    const push = (url, tagName, rel = '', source = '') => { if (url) assets.push({ url, tagName, rel, source }); };
    document.querySelectorAll('img[src]').forEach((el) => push(el.currentSrc || el.src || el.getAttribute('src'), 'img', '', 'img'));
    document.querySelectorAll('script[src]').forEach((el) => push(el.src || el.getAttribute('src'), 'script', '', 'script'));
    document.querySelectorAll('link[href]').forEach((el) => push(el.href || el.getAttribute('href'), 'link', el.getAttribute('rel') || '', 'link'));
    document.querySelectorAll('source[src]').forEach((el) => push(el.src || el.getAttribute('src'), 'source', '', 'source'));
    document.querySelectorAll('video[src], audio[src]').forEach((el) => push(el.src || el.getAttribute('src'), el.tagName.toLowerCase(), '', el.tagName.toLowerCase()));
    document.querySelectorAll('[style]').forEach((el) => push(el.getAttribute('style') || '', 'style', '', 'inline-style'));
    document.querySelectorAll('style').forEach((el) => push(el.textContent || '', 'style', '', 'style-tag'));
    const links = Array.from(document.querySelectorAll('a[href]')).map((a) => a.href || a.getAttribute('href')).filter(Boolean);
    return { title: document.title || '', assets, links };
  });

  for (const href of data.links) {
    try {
      const absolute = normalizeUrl(new URL(href, url).toString());
      if (sameOrigin(absolute, origin) && !seenPages.has(absolute) && queue.length + seenPages.size < maxPages + 10) queue.push(absolute);
    } catch {}
  }

  const pageAssetStart = assetRows.length;
  for (const asset of data.assets) {
    if (!asset.url) continue;
    if (asset.source === 'inline-style' || asset.source === 'style-tag') {
      for (const cssUrl of extractCssUrls(asset.url, url)) {
        if (seenAssets.has(cssUrl)) continue;
        seenAssets.add(cssUrl);
        const checked = await checkAsset(cssUrl, canonicalHost);
        const type = classifyAssetType(cssUrl, asset.tagName, asset.rel);
        assetRows.push({
          page_url: url, asset_url: cssUrl, asset_type: type, source: asset.source,
          status_code: checked.status, final_url: checked.final_url || '', asset_host: checked.original_host || '',
          final_host: checked.final_host || '', ok: checked.ok ? 'yes' : 'no', broken: checked.ok ? 'no' : 'yes',
          host_mismatch: checked.host_mismatch || 'no', www_mismatch: checked.www_mismatch || 'no',
          non_canonical_host: checked.non_canonical_host || 'no', staging_production_mixup: checked.staging_production_mixup || 'no',
          protocol_mismatch: checked.protocol_mismatch || 'no', content_type: checked.content_type || ''
        });
      }
      continue;
    }
    let absolute;
    try { absolute = new URL(asset.url, url).toString(); } catch { continue; }
    if (seenAssets.has(absolute)) continue;
    seenAssets.add(absolute);
    const checked = await checkAsset(absolute, canonicalHost);
    const type = classifyAssetType(absolute, asset.tagName, asset.rel);
    assetRows.push({
      page_url: url, asset_url: absolute, asset_type: type, source: asset.source,
      status_code: checked.status, final_url: checked.final_url || '', asset_host: checked.original_host || '',
      final_host: checked.final_host || '', ok: checked.ok ? 'yes' : 'no', broken: checked.ok ? 'no' : 'yes',
      host_mismatch: checked.host_mismatch || 'no', www_mismatch: checked.www_mismatch || 'no',
      non_canonical_host: checked.non_canonical_host || 'no', staging_production_mixup: checked.staging_production_mixup || 'no',
      protocol_mismatch: checked.protocol_mismatch || 'no', content_type: checked.content_type || ''
    });
    if (!checked.ok) {
      let issueType = 'broken_asset';
      if (type === 'image') issueType = 'broken_image';
      if (type === 'js') issueType = 'broken_js_asset';
      if (type === 'css') issueType = 'broken_css_asset';
      if (type === 'font') issueType = 'broken_font_asset';
      issueRows.push({ page_url: url, issue_type: issueType, severity: type === 'image' ? 'medium' : 'high', details: `${absolute} returned ${checked.status || 'network error'}` });
    }
    if (checked.www_mismatch === 'yes') issueRows.push({ page_url: url, issue_type: 'asset_www_mismatch', severity: 'medium', details: absolute });
    if (checked.host_mismatch === 'yes') issueRows.push({ page_url: url, issue_type: 'asset_host_mismatch', severity: 'medium', details: absolute });
    if (checked.staging_production_mixup === 'yes') issueRows.push({ page_url: url, issue_type: 'staging_production_asset_mixup', severity: 'high', details: absolute });
    const hostKey = checked.final_host || checked.original_host || 'unknown';
    hostMap.set(hostKey, (hostMap.get(hostKey) || 0) + 1);
  }

  const section = getSection(url);
  pageRows.push({ page_url: url, title: data.title, status_code: status, asset_count: assetRows.length - pageAssetStart, section });
  const sec = sectionMap.get(section) || { section, page_count: 0, asset_count: 0, issue_count: 0 };
  sec.page_count += 1;
  sec.asset_count += (assetRows.length - pageAssetStart);
  sec.issue_count += issueRows.filter((i) => i.page_url === url).length;
  sectionMap.set(section, sec);

  if (runLighthouse) {
    console.log('Running Lighthouse:', url);
    try { lighthouseRows.push(await runLighthouseAudit(url)); }
    catch (e) { lighthouseRows.push({ url, performance: '', lcp: '', cls: '', tbt: '', fcp: '', error: String(e) }); }
  }
}

await browser.close();

const externalHosts = assetRows.filter((r) => r.asset_host && r.asset_host !== canonicalHost).map((r) => r.final_host || r.asset_host);
const uniqueExternalHosts = [...new Set(externalHosts)];
if (uniqueExternalHosts.length > 1) {
  issueRows.push({ page_url: site, issue_type: 'cdn_inconsistency', severity: 'medium', details: `Multiple external asset hosts detected: ${uniqueExternalHosts.join(' | ')}` });
}

writeCsv(path.join(outDir, 'seo-pages.csv'), ['page_url','title','status_code','asset_count','section'], pageRows);
writeCsv(path.join(outDir, 'seo-assets.csv'), ['page_url','asset_url','asset_type','source','status_code','final_url','asset_host','final_host','ok','broken','host_mismatch','www_mismatch','non_canonical_host','staging_production_mixup','protocol_mismatch','content_type'], assetRows);
writeCsv(path.join(outDir, 'seo-issues.csv'), ['page_url','issue_type','severity','details'], issueRows);
writeCsv(path.join(outDir, 'seo-section-summary.csv'), ['section','page_count','asset_count','issue_count'], Array.from(sectionMap.values()));
writeCsv(path.join(outDir, 'seo-asset-host-summary.csv'), ['host','count'], Array.from(hostMap.entries()).sort((a,b) => b[1] - a[1]).map(([host, count]) => ({ host, count })));
if (runLighthouse) writeCsv(path.join(outDir, 'seo-lighthouse.csv'), ['url','performance','lcp','cls','tbt','fcp','error'], lighthouseRows);
if (!args['no-visual-report']) {
  console.log('Generating visual dashboard and PDF report...');
  const visualArgs = [path.resolve('scripts/generate-visual-report.mjs'), '--run-dir', outDir, '--site', site];
  if (args['brand-config']) visualArgs.push('--brand-config', args['brand-config']);
  const visual = spawnSync(process.execPath, visualArgs, { stdio: 'inherit' });
  if (visual.status !== 0) console.warn('Warning: visual report generation failed.');
}

console.log('Done:', outDir);
