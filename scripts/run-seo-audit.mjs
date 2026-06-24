#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { runLighthouseAudit } from './lib/lighthouse-runner.mjs';
import { checkAsset, classifyAssetType } from './lib/asset-checker.mjs';
import { agenticIssueFindings, collectAgenticSignals, installWebMcpCapture } from './lib/agentic-audit.mjs';
import { collectScriptInventory, scriptAuditIssueFindings, buildCspSummary } from './lib/script-audit.mjs';

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
function canonicalStatus(pageUrl, canonicalUrl, count) {
  if (!canonicalUrl) return 'missing';
  if (Number(count || 0) > 1) return 'multiple';
  try {
    const page = new URL(normalizeUrl(pageUrl));
    const canonical = new URL(normalizeUrl(canonicalUrl));
    if (page.origin !== canonical.origin) return 'cross_domain';
    if (page.toString() === canonical.toString()) return 'self_referencing';
    return 'mismatch';
  } catch {
    return 'invalid';
  }
}
function validateHreflangs(hreflangs = []) {
  const seen = new Set();
  let invalid = 0;
  let duplicates = 0;
  let hasXDefault = false;
  for (const h of hreflangs) {
    const code = String(h.hreflang || '').trim().toLowerCase();
    const href = String(h.href || '').trim();
    if (!code || !href) invalid++;
    if (code === 'x-default') hasXDefault = true;
    if (code) {
      if (seen.has(code)) duplicates++;
      seen.add(code);
    }
  }
  return { invalid, duplicates, hasXDefault: hasXDefault ? 'yes' : 'no' };
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
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  bgRed: '\x1b[41m', bgGreen: '\x1b[42m', bgYellow: '\x1b[43m', bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m', bgCyan: '\x1b[46m',
  brightRed: '\x1b[91m', brightGreen: '\x1b[92m', brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m', brightMagenta: '\x1b[95m', brightCyan: '\x1b[96m'
};
const rainbowColors = [c.brightRed, c.brightYellow, c.brightGreen, c.brightCyan, c.brightBlue, c.brightMagenta];
function rainbow(text) {
  return [...text].map((ch, i) => ch === ' ' ? ch : `${rainbowColors[i % rainbowColors.length]}${ch}`).join('') + c.reset;
}
function rainbowBar(filled, empty, width = 30) {
  const chars = [];
  for (let i = 0; i < filled; i++) {
    chars.push(`${rainbowColors[i % rainbowColors.length]}${'█'}`);
  }
  return chars.join('') + `${c.dim}${'░'.repeat(empty)}${c.reset}`;
}
function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}
const spinnerFrames = ['◐', '◓', '◑', '◒'];
let spinnerIdx = 0;
function spinner() { return rainbowColors[spinnerIdx % rainbowColors.length] + spinnerFrames[spinnerIdx++ % spinnerFrames.length] + c.reset; }
function progressLine(current, total, label, extra = '') {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const barWidth = 30;
  const filled = total > 0 ? Math.round((current / total) * barWidth) : 0;
  const bar = rainbowBar(filled, barWidth - filled, barWidth);
  const pctStr = pct === 100 ? `${c.brightGreen}${pct}%${c.reset}` : `${c.brightCyan}${pct}%${c.reset}`;
  const spin = current < total ? spinner() : `${c.brightGreen}✔${c.reset}`;
  process.stdout.write(`\r  ${spin} ${bar} ${c.bold}${current}${c.reset}${c.dim}/${total}${c.reset} ${pctStr} ${c.dim}${label}${c.reset}${extra ? ' ' + extra : ''}`.padEnd(160) + '\r');
}
function phaseHeader(label, icon = '▸') {
  console.log('');
  console.log(`  ${rainbow(icon)} ${c.bold}${c.brightCyan}${label}${c.reset} ${c.dim}${'─'.repeat(Math.max(0, 52 - label.length))}${c.reset}`);
}
function phaseDone(label, elapsed) {
  console.log(`    ${c.brightGreen}✔${c.reset} ${label} ${c.dim}in${c.reset} ${c.brightYellow}${formatDuration(elapsed)}${c.reset}`);
}
function statusMsg(icon, color, msg) {
  console.log(`    ${color}${icon}${c.reset} ${msg}`);
}
function severityColor(count, threshold = 0) {
  if (count === 0) return `${c.brightGreen}${count}${c.reset}`;
  if (count > threshold) return `${c.brightRed}${count}${c.reset}`;
  return `${c.brightYellow}${count}${c.reset}`;
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

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Universal-SEO-Audit',
      'accept': 'text/plain, text/html, application/xml, text/xml, */*'
    }
  });
  if (!res.ok) throw new Error(`Failed ${res.status}: ${url}`);
  return await res.text();
}
function parseSitemapLocs(xml) {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/gsi)].map((m) => normalizeUrl(m[1].trim())).filter(Boolean);
}
function filterSitemapUrls(urls, args) {
  const includeSitemaps = String(args['include-sitemaps'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (includeSitemaps.length) return urls.filter((u) => includeSitemaps.some((part) => u.includes(part)));
  if (args['content-sitemaps-only']) {
    return urls.filter((u) => /(post|page|wp-sitemap-posts|portfolio|leadership|webinar|podcast|news|testimonial)/i.test(u));
  }
  return urls;
}
async function discoverUrlsFromSitemap(site, args) {
  const base = new URL(site).origin;
  const candidates = [args['sitemap-url'], `${base}/sitemap_index.xml`, `${base}/wp-sitemap.xml`, `${base}/sitemap.xml`].filter(Boolean);
  let sitemapUrl = null;
  let xml = null;
  for (const c of candidates) {
    try {
      xml = await fetchText(c);
      sitemapUrl = c;
      break;
    } catch {}
  }
  if (!xml || !sitemapUrl) throw new Error('Could not fetch sitemap');
  console.log(`Using sitemap: ${sitemapUrl}`);
  let urls = [];
  if (/<sitemapindex/i.test(xml)) {
    const sitemapUrls = filterSitemapUrls(parseSitemapLocs(xml), args);
    console.log(`Found sitemap index; selected ${sitemapUrls.length} sitemap file(s)`);
    for (const su of sitemapUrls) {
      console.log(`Processing ${su}`);
      try { urls.push(...parseSitemapLocs(await fetchText(su))); } catch (e) { console.warn(`Warning: could not fetch nested sitemap ${su}`); }
    }
  } else {
    urls = parseSitemapLocs(xml);
  }
  urls = [...new Set(urls)].filter((u) => {
    try { return sameOrigin(u, site); } catch { return false; }
  });
  if (args['max-pages']) urls = urls.slice(0, Number(args['max-pages']));
  return urls;
}

const args = parseArgs(process.argv);
if (!args.site) {
  console.error('Missing --site');
  process.exit(1);
}
const site = args.site;
const maxPages = args['max-pages'] ? Number(args['max-pages']) : null;
const runLighthouse = Boolean(args['lighthouse']);
const outDir = path.resolve('reports/' + runId(site));
fs.mkdirSync(outDir, { recursive: true });

const auditStartTime = Date.now();
console.log('');
console.log(`  ${rainbow('╔══════════════════════════════════════════════════════════╗')}`);
console.log(`  ${rainbow('║')}  ${c.bold}${c.brightCyan}⚡ Universal SEO Audit${c.reset}                                ${rainbow('║')}`);
console.log(`  ${rainbow('║')}  ${c.dim}Technical SEO · Assets · Scripts · CSP · Agentic${c.reset}       ${rainbow('║')}`);
console.log(`  ${rainbow('╚══════════════════════════════════════════════════════════╝')}`);
console.log('');
console.log(`  ${c.brightMagenta}🎯${c.reset} ${c.bold}Target:${c.reset}     ${c.brightCyan}${site}${c.reset}`);
console.log(`  ${c.brightMagenta}📁${c.reset} ${c.bold}Output:${c.reset}     ${c.dim}${outDir}${c.reset}`);
console.log(`  ${c.brightMagenta}🔬${c.reset} ${c.bold}Lighthouse:${c.reset} ${runLighthouse ? `${c.brightGreen}enabled${c.reset}` : `${c.dim}disabled${c.reset}`}`);

phaseHeader('Phase 1: Setup', '🚀');
const setupStart = Date.now();
const origin = new URL(site).origin;
const canonicalHost = new URL(site).host;
statusMsg('◐', c.cyan, 'Launching headless browser...');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await installWebMcpCapture(context);
const page = await context.newPage();
phaseDone('Browser ready', Date.now() - setupStart);

phaseHeader('Phase 2: URL discovery', '🗺️');
const discoveryStart = Date.now();
let discoveredUrls = [];
if (args['urls-file']) {
  discoveredUrls = fs.readFileSync(path.resolve(args['urls-file']), 'utf8').split(/\r?\n/g).map((s) => s.trim()).filter(Boolean).map(normalizeUrl);
  if (maxPages) discoveredUrls = discoveredUrls.slice(0, maxPages);
  statusMsg('📄', c.cyan, `URL file: ${c.bold}${args['urls-file']}${c.reset} ${c.dim}(${discoveredUrls.length} URLs)${c.reset}`);
} else if (!args['crawl']) {
  try {
    statusMsg('◐', c.cyan, 'Fetching sitemap...');
    discoveredUrls = await discoverUrlsFromSitemap(site, args);
    statusMsg('🌐', c.brightGreen, `Found ${c.bold}${discoveredUrls.length}${c.reset} URL(s) from sitemap`);
    fs.writeFileSync(path.join(outDir, 'urls.txt'), discoveredUrls.join('\n') + '\n', 'utf8');
  } catch (e) {
    statusMsg('⚠', c.brightYellow, 'Sitemap discovery failed. Falling back to browser crawl.');
    discoveredUrls = [normalizeUrl(site)];
  }
} else {
  discoveredUrls = [normalizeUrl(site)];
  statusMsg('🕷️', c.cyan, 'Browser crawl mode');
}
if (runLighthouse && discoveredUrls.length > 50 && !maxPages) {
  statusMsg('⚠', c.brightYellow, `Lighthouse enabled for ${c.bold}${discoveredUrls.length}${c.reset}${c.brightYellow} URLs — this will take a while. Use --max-pages 10 for a sample.${c.reset}`);
}
const totalPages = maxPages ? Math.min(maxPages, discoveredUrls.length) : discoveredUrls.length;
const estPerPage = runLighthouse ? 25000 : 8000;
const estTotal = totalPages * estPerPage;
statusMsg('⏱️', c.brightMagenta, `Estimated: ${c.bold}~${formatDuration(estTotal)}${c.reset} ${c.dim}(${totalPages} pages${runLighthouse ? ' + Lighthouse' : ''})${c.reset}`);
phaseDone('URL discovery', Date.now() - discoveryStart);
phaseHeader('Phase 3: Page scanning', '🔍');
const scanStart = Date.now();
const pageTimes = [];
const queue = [...discoveredUrls];
const seenPages = new Set();
const seenAssets = new Set();
const pageRows = [];
const assetRows = [];
const issueRows = [];
const lighthouseRows = [];
const agenticRows = [];
const scriptRows = [];
const sectionMap = new Map();
const hostMap = new Map();

while (queue.length && (!maxPages || seenPages.size < maxPages)) {
  const url = queue.shift();
  if (seenPages.has(url)) continue;
  seenPages.add(url);
  const pageStart = Date.now();
  const pageNum = seenPages.size;
  const avgMs = pageTimes.length > 0 ? pageTimes.reduce((a, b) => a + b, 0) / pageTimes.length : estPerPage;
  const remaining = totalPages - pageNum;
  const eta = remaining > 0 ? formatDuration(remaining * avgMs) : '0s';
  const shortUrl = url.length > 55 ? url.slice(0, 52) + '...' : url;
  progressLine(pageNum, totalPages, shortUrl, `${c.dim}ETA:${c.reset} ${c.brightYellow}~${eta}${c.reset}`);
  let status = 0;
  try {
    const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
    status = res?.status?.() || 0;
  } catch {
    status = 0;
  }

  let data;
  try {
    data = await page.evaluate(() => {
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
      const canonicals = Array.from(document.querySelectorAll('link[rel="canonical" i]')).map((el) => el.href || el.getAttribute('href') || '').filter(Boolean);
      const hreflangs = Array.from(document.querySelectorAll('link[rel="alternate" i][hreflang]')).map((el) => ({
        hreflang: el.getAttribute('hreflang') || '',
        href: el.href || el.getAttribute('href') || ''
      }));
      return { title: document.title || '', assets, links, canonicals, hreflangs };
    });
  } catch (evaluateError) {
    console.warn(`Warning: DOM extraction failed for ${url}. Retrying after reload. ${evaluateError?.message || evaluateError}`);
    try {
      const retryRes = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      status = retryRes?.status?.() || status;
      await page.waitForTimeout(750);
      data = await page.evaluate(() => {
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
        const canonicals = Array.from(document.querySelectorAll('link[rel="canonical" i]')).map((el) => el.href || el.getAttribute('href') || '').filter(Boolean);
        const hreflangs = Array.from(document.querySelectorAll('link[rel="alternate" i][hreflang]')).map((el) => ({
          hreflang: el.getAttribute('hreflang') || '',
          href: el.href || el.getAttribute('href') || ''
        }));
        return { title: document.title || '', assets, links, canonicals, hreflangs };
      });
    } catch (retryError) {
      console.warn(`Warning: Skipping DOM extraction for ${url}. ${retryError?.message || retryError}`);
      issueRows.push({
        page_url: url,
        issue_type: 'page_extraction_error',
        severity: 'high',
        details: retryError?.message || String(retryError)
      });
      pageRows.push({ page_url: url, title: '', status_code: status, asset_count: 0, section: getSection(url), canonical_count: 0, canonical: '', hreflang_count: 0, hreflangs: '' });
      continue;
    }
  }

  for (const href of data.links) {
    try {
      const absolute = normalizeUrl(new URL(href, url).toString());
      if (args['crawl'] && sameOrigin(absolute, origin) && !seenPages.has(absolute) && (!maxPages || queue.length + seenPages.size < maxPages)) queue.push(absolute);
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
  const canonical = (data.canonicals && data.canonicals[0]) ? normalizeUrl(data.canonicals[0]) : '';
  const canonical_count = (data.canonicals || []).length;
  const canonical_status = canonicalStatus(url, canonical, canonical_count);
  const hreflang_count = (data.hreflangs || []).length;
  const hreflangValidation = validateHreflangs(data.hreflangs || []);
  const hreflang_values = (data.hreflangs || []).map((h) => `${h.hreflang}:${h.href}`).join(' | ');

  if (!canonical) issueRows.push({ page_url: url, issue_type: 'canonical_missing', severity: 'medium', details: 'Missing canonical tag.' });
  if (canonical_count > 1) issueRows.push({ page_url: url, issue_type: 'canonical_duplicate', severity: 'high', details: `Found ${canonical_count} canonical tags: ${(data.canonicals || []).join(' | ')}` });
  if (canonical_status === 'cross_domain') issueRows.push({ page_url: url, issue_type: 'canonical_cross_domain', severity: 'high', details: `Canonical points to another domain: ${canonical}` });
  if (canonical_status === 'mismatch') issueRows.push({ page_url: url, issue_type: 'canonical_mismatch', severity: 'medium', details: `Canonical does not match crawled URL: ${canonical}` });
  if (canonical_status === 'invalid') issueRows.push({ page_url: url, issue_type: 'canonical_invalid', severity: 'high', details: `Canonical URL could not be parsed: ${canonical}` });

  if (hreflang_count === 0) issueRows.push({ page_url: url, issue_type: 'hreflang_missing', severity: 'low', details: 'No hreflang tags found. This is only an issue for multilingual or multi-region sites.' });
  if (hreflangValidation.invalid > 0) issueRows.push({ page_url: url, issue_type: 'hreflang_invalid', severity: 'medium', details: `${hreflangValidation.invalid} hreflang tag(s) are missing hreflang or href values.` });
  if (hreflangValidation.duplicates > 0) issueRows.push({ page_url: url, issue_type: 'hreflang_duplicate', severity: 'medium', details: `${hreflangValidation.duplicates} duplicate hreflang value(s) found.` });

  pageRows.push({
    page_url: url,
    title: data.title,
    status_code: status,
    canonical,
    canonical_count,
    canonical_status,
    hreflang_present: hreflang_count > 0 ? 'yes' : 'no',
    hreflang_count,
    hreflang_invalid_count: hreflangValidation.invalid,
    hreflang_duplicate_count: hreflangValidation.duplicates,
    hreflang_has_x_default: hreflangValidation.hasXDefault,
    hreflang_values,
    asset_count: assetRows.length - pageAssetStart,
    section
  });
  const sec = sectionMap.get(section) || { section, page_count: 0, asset_count: 0, issue_count: 0 };
  sec.page_count += 1;
  sec.asset_count += (assetRows.length - pageAssetStart);
  sec.issue_count += issueRows.filter((i) => i.page_url === url).length;
  sectionMap.set(section, sec);

  let lighthouseRow = null;
  if (runLighthouse) {
    progressLine(pageNum, totalPages, shortUrl, `${c.brightYellow}⚡ Lighthouse...${c.reset}`);
    try {
      lighthouseRow = await runLighthouseAudit(url);
      lighthouseRows.push(lighthouseRow);
    }
    catch (e) {
      lighthouseRow = { url, page_url: url, final_url: url, lighthouse_available: 'no', performance: '', performance_score: '', lcp: '', lcp_ms: '', cls: '', tbt: '', tbt_ms: '', fcp: '', fcp_ms: '', si_ms: '', error: String(e), note: String(e) };
      lighthouseRows.push(lighthouseRow);
    }
  }

  try {
    const agenticRow = await collectAgenticSignals(page, url, lighthouseRow || {});
    agenticRows.push(agenticRow);
    const findings = agenticIssueFindings(agenticRow);
    for (const finding of findings) {
      issueRows.push({ page_url: url, issue_type: finding.issue_type, severity: finding.severity, details: finding.details });
    }
    const sectionSummary = sectionMap.get(section);
    if (sectionSummary) sectionSummary.issue_count += findings.length;
  } catch (e) {
    agenticRows.push({ page_url: url, agentic_score: '', agentic_grade: '', note: `Agentic scoring failed: ${String(e?.message || e)}` });
  }

  try {
    const scriptRow = await collectScriptInventory(page, url);
    const csvRow = { ...scriptRow };
    delete csvRow.external_scripts;
    delete csvRow.inline_handler_samples;
    scriptRows.push(csvRow);
    const scriptFindings = scriptAuditIssueFindings(scriptRow);
    for (const finding of scriptFindings) {
      issueRows.push({ page_url: url, issue_type: finding.issue_type, severity: finding.severity, details: finding.details });
    }
    const sectionSummary = sectionMap.get(section);
    if (sectionSummary) sectionSummary.issue_count += scriptFindings.length;
  } catch (e) {
    scriptRows.push({ page_url: url, total_script_count: 0, note: `Script audit failed: ${String(e?.message || e)}` });
  }

  const pageElapsed = Date.now() - pageStart;
  pageTimes.push(pageElapsed);
  const issuesOnPage = issueRows.filter((i) => i.page_url === url).length;
  const assetsOnPage = assetRows.length - pageAssetStart;
  const issueIcon = issuesOnPage === 0 ? `${c.brightGreen}✔${c.reset}` : issuesOnPage > 5 ? `${c.brightRed}✖${c.reset}` : `${c.brightYellow}●${c.reset}`;
  console.log(`  ${issueIcon} ${c.dim}[${pageNum}/${totalPages}]${c.reset} ${c.brightCyan}${formatDuration(pageElapsed)}${c.reset} ${c.dim}│${c.reset} ${c.white}${assetsOnPage}${c.reset} assets ${c.dim}│${c.reset} ${severityColor(issuesOnPage, 5)} issues ${c.dim}│${c.reset} ${c.dim}${shortUrl}${c.reset}`);
}

console.log('');
phaseDone(`Scanned ${c.bold}${seenPages.size}${c.reset} pages`, Date.now() - scanStart);
statusMsg('📊', c.brightCyan, `Total: ${severityColor(issueRows.length, 20)} issues, ${c.bold}${assetRows.length}${c.reset} assets checked`);

await browser.close();

const externalHosts = assetRows.filter((r) => r.asset_host && r.asset_host !== canonicalHost).map((r) => r.final_host || r.asset_host);
const uniqueExternalHosts = [...new Set(externalHosts)];
if (uniqueExternalHosts.length > 1) {
  issueRows.push({ page_url: site, issue_type: 'cdn_inconsistency', severity: 'medium', details: `Multiple external asset hosts detected: ${uniqueExternalHosts.join(' | ')}` });
}

phaseHeader('Phase 4: Report generation', '📝');
const reportStart = Date.now();
statusMsg('💾', c.cyan, 'Writing CSV data files...');
writeCsv(path.join(outDir, 'seo-pages.csv'), ['page_url','title','status_code','canonical','canonical_count','canonical_status','hreflang_present','hreflang_count','hreflang_invalid_count','hreflang_duplicate_count','hreflang_has_x_default','hreflang_values','asset_count','section'], pageRows);
writeCsv(path.join(outDir, 'seo-assets.csv'), ['page_url','asset_url','asset_type','source','status_code','final_url','asset_host','final_host','ok','broken','host_mismatch','www_mismatch','non_canonical_host','staging_production_mixup','protocol_mismatch','content_type'], assetRows);
writeCsv(path.join(outDir, 'seo-issues.csv'), ['page_url','issue_type','severity','details'], issueRows);
writeCsv(path.join(outDir, 'seo-section-summary.csv'), ['section','page_count','asset_count','issue_count'], Array.from(sectionMap.values()));
writeCsv(path.join(outDir, 'seo-asset-host-summary.csv'), ['host','count'], Array.from(hostMap.entries()).sort((a,b) => b[1] - a[1]).map(([host, count]) => ({ host, count })));
if (runLighthouse) writeCsv(path.join(outDir, 'seo-lighthouse.csv'), ['url','performance','lcp','cls','tbt','fcp','error'], lighthouseRows);
writeCsv(path.join(outDir, 'seo-agentic.csv'), ['page_url','agentic_score','agentic_grade','webmcp_protocol_score','webmcp_tools_registered','webmcp_tools_with_schema','webmcp_reference_count','webmcp_tool_names','accessibility_tree_score','form_control_count','named_form_control_count','clickable_count','named_clickable_count','semantic_data_score','llms_txt_present','llms_txt_url','llms_txt_status','llms_txt_bytes','llms_txt_headings','llms_txt_links','layout_stability_score','cls','visible_image_count','images_with_dimensions_count','note'], agenticRows);
writeCsv(path.join(outDir, 'seo-scripts.csv'), ['page_url','external_script_count','inline_script_count','total_script_count','inline_event_handler_count','javascript_link_count','first_party_script_domains','first_party_script_count','third_party_script_domains','third_party_script_count','unique_script_domains','uses_eval','uses_document_write','uses_innerhtml','all_inline_have_nonce','all_external_have_integrity','async_script_count','defer_script_count','render_blocking_script_count','needs_unsafe_inline','needs_unsafe_eval','suggested_script_src'], scriptRows);
const cspSummary = buildCspSummary(scriptRows, origin);
writeCsv(path.join(outDir, 'seo-csp-summary.csv'), ['pages_audited','total_external_scripts','total_inline_scripts','total_inline_event_handlers','total_javascript_links','total_render_blocking','unique_third_party_domains','third_party_domains','needs_unsafe_inline','needs_unsafe_eval','pages_with_eval','pages_with_document_write','suggested_script_src'], [cspSummary]);
if (!args['no-visual-report']) {
  statusMsg('🎨', c.cyan, 'Generating visual dashboard and PDF report...');
  const visualArgs = [path.resolve('scripts/generate-visual-report.mjs'), '--run-dir', outDir, '--site', site];
  if (args['brand-config']) visualArgs.push('--brand-config', args['brand-config']);
  const visual = spawnSync(process.execPath, visualArgs, { stdio: 'inherit' });
  if (visual.status !== 0) statusMsg('⚠', c.brightYellow, 'Visual report generation failed.');
}
phaseDone('Reports written', Date.now() - reportStart);

const totalElapsed = Date.now() - auditStartTime;
const totalScripts = scriptRows.reduce((a, r) => a + (r.total_script_count || 0), 0);
const extScripts = scriptRows.reduce((a, r) => a + (r.external_script_count || 0), 0);
const inlScripts = scriptRows.reduce((a, r) => a + (r.inline_script_count || 0), 0);
console.log('');
console.log(`  ${rainbow('╔══════════════════════════════════════════════════════════╗')}`);
console.log(`  ${rainbow('║')}  ${c.bold}${c.brightGreen}✨ Audit Complete!${c.reset}                                    ${rainbow('║')}`);
console.log(`  ${rainbow('╚══════════════════════════════════════════════════════════╝')}`);
console.log('');
console.log(`  ${c.brightCyan}🎯${c.reset} ${c.bold}Site${c.reset}        ${site}`);
console.log(`  ${c.brightCyan}📄${c.reset} ${c.bold}Pages${c.reset}       ${c.brightGreen}${seenPages.size}${c.reset}`);
console.log(`  ${c.brightCyan}🔗${c.reset} ${c.bold}Assets${c.reset}      ${c.brightGreen}${assetRows.length}${c.reset}`);
console.log(`  ${c.brightCyan}⚠️${c.reset}  ${c.bold}Issues${c.reset}      ${severityColor(issueRows.length, 20)}`);
console.log(`  ${c.brightCyan}📜${c.reset} ${c.bold}Scripts${c.reset}     ${c.brightGreen}${totalScripts}${c.reset} ${c.dim}(${extScripts} external, ${inlScripts} inline)${c.reset}`);
console.log(`  ${c.brightCyan}⏱️${c.reset}  ${c.bold}Time${c.reset}        ${c.brightYellow}${formatDuration(totalElapsed)}${c.reset}`);
console.log(`  ${c.brightCyan}📁${c.reset} ${c.bold}Output${c.reset}      ${c.dim}${outDir}${c.reset}`);
console.log('');
console.log(`  ${rainbow('★ ★ ★')} ${c.dim}Happy auditing!${c.reset} ${rainbow('★ ★ ★')}`);
console.log('');
