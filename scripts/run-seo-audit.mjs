#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Large --crawl runs accumulate thousands of page/asset/issue rows in memory before
// they're flushed to CSV at the end (see Phase 4). The default V8 heap ceiling (~4GB)
// isn't enough for that on big sites, and heap flags can only be set at process start —
// so re-exec ourselves once with a much larger ceiling before doing any real work.
if (!process.env.__SEO_AUDIT_REEXEC__) {
  const hasHeapFlag = process.execArgv.some((f) => f.startsWith('--max-old-space-size'));
  if (!hasHeapFlag) {
    const result = spawnSync(
      process.execPath,
      ['--max-old-space-size=8192', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, __SEO_AUDIT_REEXEC__: '1' } }
    );
    process.exit(result.status ?? 1);
  }
}

import { chromium } from 'playwright';
import { runLighthouseAudit, launchLighthouseChrome, closeLighthouseChrome } from './lib/lighthouse-runner.mjs';
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
function normalizeWhitespace(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
const NON_PAGE_EXTENSION_RE = /\.(jpg|jpeg|png|gif|webp|avif|bmp|ico|svg|tiff?|heic|pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|dmg|exe|mp3|mp4|m4a|mov|avi|wav|ogg|ogv|webm|flac|woff2?|ttf|eot|otf|csv|xml|json|rss|css|js|mjs)$/i;
function isCrawlablePage(u) {
  try { return !NON_PAGE_EXTENSION_RE.test(new URL(u).pathname); } catch { return true; }
}
function canonicalStatus(pageUrl, canonicalUrl, count) {
  if (!canonicalUrl) return 'missing';
  if (Number(count || 0) > 1) return 'multiple';
  try {
    const p = new URL(normalizeUrl(pageUrl));
    const can = new URL(normalizeUrl(canonicalUrl));
    if (p.origin !== can.origin) return 'cross_domain';
    if (p.toString() === can.toString()) return 'self_referencing';
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
function looksLikeFilename(s) {
  const v = (s || '').toLowerCase();
  if (!v) return false;
  if (/(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg)$/i.test(v)) return true;
  if (/^(img|dsc|pxl|image)[-_\s]?\d+/.test(v)) return true;
  return /[_-]/.test(v) && !/\s/.test(v) && /[a-z]/.test(v) && v.length >= 8;
}
function tokenSet(text) {
  return new Set(String(text || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2));
}
function jaccardSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
function escapeCsv(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function writeCsv(filePath, columns, rows) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((col) => escapeCsv(row[col])).join(','));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}
async function checkLink(url) {
  const headers = { 'user-agent': 'Universal-SEO-Audit Link Checker' };
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers });
    if (res.status === 405 || res.status === 501) res = await fetch(url, { method: 'GET', redirect: 'follow', headers });
    return { status: res.status, ok: res.ok };
  } catch (e) {
    return { status: 0, ok: false, error: String(e?.message || e) };
  }
}

// ── Terminal UI helpers ────────────────────────────────────────────────
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
  return chars.join('') + `${c.dim}${'░'.repeat(Math.max(0, empty))}${c.reset}`;
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
function progressLine(current, total, label, extra = '', done = current >= total && total > 0) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const barWidth = 30;
  const filled = total > 0 ? Math.min(barWidth, Math.round((current / total) * barWidth)) : 0;
  const bar = rainbowBar(filled, barWidth - filled, barWidth);
  const pctStr = pct === 100 ? `${c.brightGreen}${pct}%${c.reset}` : `${c.brightCyan}${pct}%${c.reset}`;
  const spin = done ? `${c.brightGreen}✔${c.reset}` : spinner();
  process.stdout.write(`\r  ${spin} ${bar} ${c.bold}${current}${c.reset}${c.dim}/${total}${c.reset} ${pctStr} ${c.dim}${label}${c.reset}${extra ? ' ' + extra : ''}\x1b[K`);
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

// ── Asset / sitemap helpers ────────────────────────────────────────────
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
  for (const cand of candidates) {
    try {
      xml = await fetchText(cand);
      sitemapUrl = cand;
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
  const pages = urls.filter((u) => isCrawlablePage(u));
  const files = urls.filter((u) => !isCrawlablePage(u));
  return { pages, files };
}

// ── Full-page SEO extraction (runs inside page.evaluate) ───────────────
async function extractFullPageData(page) {
  return await page.evaluate(() => {
    // Assets
    const assets = [];
    const push = (url, tagName, rel = '', source = '') => { if (url) assets.push({ url, tagName, rel, source }); };
    document.querySelectorAll('img[src]').forEach((el) => push(el.currentSrc || el.src || el.getAttribute('src'), 'img', '', 'img'));
    document.querySelectorAll('script[src]').forEach((el) => push(el.src || el.getAttribute('src'), 'script', '', 'script'));
    document.querySelectorAll('link[href]').forEach((el) => push(el.href || el.getAttribute('href'), 'link', el.getAttribute('rel') || '', 'link'));
    document.querySelectorAll('source[src]').forEach((el) => push(el.src || el.getAttribute('src'), 'source', '', 'source'));
    document.querySelectorAll('video[src], audio[src]').forEach((el) => push(el.src || el.getAttribute('src'), el.tagName.toLowerCase(), '', el.tagName.toLowerCase()));
    document.querySelectorAll('[style]').forEach((el) => push(el.getAttribute('style') || '', 'style', '', 'inline-style'));
    document.querySelectorAll('style').forEach((el) => push(el.textContent || '', 'style', '', 'style-tag'));

    // Links with anchor text
    const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
      href: a.href || a.getAttribute('href') || '',
      text: (a.textContent || '').trim()
    }));

    // Canonicals & hreflangs
    const canonicals = Array.from(document.querySelectorAll('link[rel="canonical" i]')).map((el) => el.href || el.getAttribute('href') || '').filter(Boolean);
    const hreflangs = Array.from(document.querySelectorAll('link[rel="alternate" i][hreflang]')).map((el) => ({
      hreflang: el.getAttribute('hreflang') || '',
      href: el.href || el.getAttribute('href') || ''
    }));

    // Core SEO metadata
    const title = document.title || '';
    const desc = document.querySelector('meta[name="description" i]')?.getAttribute('content') || '';
    const robotsMeta = document.querySelector('meta[name="robots" i]')?.getAttribute('content') || '';
    const viewportMeta = document.querySelector('meta[name="viewport" i]')?.getAttribute('content') || '';
    const htmlLang = document.documentElement?.getAttribute('lang') || '';

    // Open Graph
    const ogTitle = document.querySelector('meta[property="og:title" i]')?.getAttribute('content') || '';
    const ogDescription = document.querySelector('meta[property="og:description" i]')?.getAttribute('content') || '';
    const ogImage = document.querySelector('meta[property="og:image" i]')?.getAttribute('content') || '';
    const ogUrl = document.querySelector('meta[property="og:url" i]')?.getAttribute('content') || '';

    // Twitter Card
    const twitterCard = document.querySelector('meta[name="twitter:card" i]')?.getAttribute('content') || '';
    const twitterTitle = document.querySelector('meta[name="twitter:title" i]')?.getAttribute('content') || '';
    const twitterDescription = document.querySelector('meta[name="twitter:description" i]')?.getAttribute('content') || '';
    const twitterImage = document.querySelector('meta[name="twitter:image" i]')?.getAttribute('content') || '';

    // Headings
    const h1s = Array.from(document.querySelectorAll('h1')).map((n) => n.textContent?.trim() || '');
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).map((n) => ({
      tag: n.tagName.toLowerCase(),
      text: (n.textContent || '').trim()
    })).slice(0, 20);

    // Body text
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;

    // Images with alt text
    const images = Array.from(document.images).map((img) => ({
      src: img.currentSrc || img.getAttribute('src') || '',
      alt: img.getAttribute('alt') || '',
      title: img.getAttribute('title') || ''
    }));

    // JSON-LD / Structured data
    const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((n) => n.textContent || '');
    let jsonLdValidCount = 0;
    let jsonLdInvalidCount = 0;
    const schemaTypes = [];
    for (const raw of jsonLdScripts) {
      try {
        const parsed = JSON.parse(raw);
        jsonLdValidCount++;
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item && typeof item === 'object') {
            const t = item['@type'];
            if (Array.isArray(t)) schemaTypes.push(...t.map(String));
            else if (t) schemaTypes.push(String(t));
            if (Array.isArray(item['@graph'])) {
              for (const node of item['@graph']) {
                const gt = node?.['@type'];
                if (Array.isArray(gt)) schemaTypes.push(...gt.map(String));
                else if (gt) schemaTypes.push(String(gt));
              }
            }
          }
        }
      } catch {
        jsonLdInvalidCount++;
      }
    }

    // DOM stats
    const domNodeCount = document.querySelectorAll('*').length;
    const scriptTagCount = document.querySelectorAll('script').length;
    const stylesheetCount = document.querySelectorAll('link[rel="stylesheet"]').length;
    const resourceCount = (performance.getEntriesByType('resource') || []).length;

    return {
      assets, links, canonicals, hreflangs,
      title, title_length: title.length,
      meta_description: desc, meta_description_length: desc.length,
      robots_meta: robotsMeta,
      robots_indexable: !/noindex/i.test(robotsMeta),
      robots_followable: !/nofollow/i.test(robotsMeta),
      viewport_meta: viewportMeta,
      html_lang: htmlLang,
      og_title: ogTitle, og_description: ogDescription, og_image: ogImage, og_url: ogUrl,
      twitter_card: twitterCard, twitter_title: twitterTitle, twitter_description: twitterDescription, twitter_image: twitterImage,
      h1_count: h1s.length, h1_text: h1s.join(' | '),
      heading_outline: headings.map((h) => `${h.tag}:${h.text}`).join(' | '),
      word_count: wordCount,
      body_excerpt: bodyText.slice(0, 4000),
      images,
      jsonld_count: jsonLdScripts.length,
      jsonld_valid_count: jsonLdValidCount,
      jsonld_invalid_count: jsonLdInvalidCount,
      schema_types: Array.from(new Set(schemaTypes.filter(Boolean))).join(' | '),
      dom_node_count: domNodeCount,
      script_tag_count: scriptTagCount,
      stylesheet_count: stylesheetCount,
      resource_count: resourceCount,
    };
  });
}

// ── Bot protection / robots.txt / authentication helpers ───────────────
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function decodeUrlForDisplay(u) { try { return decodeURI(String(u || '')); } catch { return String(u || ''); } }
function detectBotChallengeHtml(html = '', status = 0) {
  const s = String(html || '').toLowerCase();
  const statusCode = Number(status) || 0;
  const isChallengeStatus = [403, 429, 503].includes(statusCode);
  // High-confidence phrases from real interstitial/challenge pages. Deliberately narrow --
  // a bare "cloudflare" or "captcha" substring match false-positives on any normal page that's
  // merely served via Cloudflare's CDN or embeds a reCAPTCHA/hCaptcha widget on a contact form.
  const strongPhrases = [
    'checking your browser before accessing',
    'please stand by, while we are checking your browser',
    'attention required! | cloudflare',
    'just a moment...',
    'verify you are a human',
    'verify you are human',
    'please verify you are a human',
    'captcha-delivery.com',
    'hcaptcha-challenge',
    'cf-turnstile',
    'ddos protection by',
  ];
  const strongMatch = strongPhrases.find((needle) => s.includes(needle));
  // Generic keywords are only trustworthy alongside a challenge-like HTTP status.
  const weakCloudflare = isChallengeStatus && s.includes('cloudflare');
  const weakCaptcha = isChallengeStatus && s.includes('captcha');
  const detected = Boolean(strongMatch) || isChallengeStatus;
  let type = 'unknown';
  if (strongMatch) type = /cloudflare|just a moment|turnstile/.test(strongMatch) ? 'cloudflare' : 'captcha';
  else if (weakCloudflare) type = 'cloudflare';
  else if (weakCaptcha) type = 'captcha';
  else if (isChallengeStatus) type = `http_${statusCode}`;
  return { detected, type, status: statusCode };
}
async function buildRobotsMatcher(startUrl) {
  try {
    const robotsUrl = new URL('/robots.txt', startUrl).toString();
    const text = await fetchText(robotsUrl);
    const disallows = [];
    let crawlDelayMs = 0;
    for (const line of text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      const m = /^disallow:\s*(.+)$/i.exec(trimmed);
      if (m) disallows.push(m[1].trim());
      const cd = /^crawl-delay:\s*(\d+)$/i.exec(trimmed);
      if (cd && !crawlDelayMs) crawlDelayMs = Number(cd[1]) * 1000;
    }
    function isAllowedUrl(url) {
      try {
        const u = new URL(url);
        const pathWithQuery = `${u.pathname}${u.search || ''}`;
        for (const rule of disallows) {
          if (!rule || rule === '/') continue;
          const normalized = rule.replace(/\*$/, '');
          if (pathWithQuery.startsWith(normalized) || pathWithQuery.includes(normalized.replace(/\*/g, ''))) return false;
        }
        return true;
      } catch { return true; }
    }
    return { isAllowedUrl, crawlDelayMs };
  } catch { return { isAllowedUrl: null, crawlDelayMs: 0 }; }
}
function loadAuthConfig(filePath) {
  try { return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf8')); }
  catch (e) { throw new Error(`Could not read auth config at ${filePath}: ${String(e?.message || e)}`); }
}
function getAuthSettings(args) {
  let cfg = {};
  if (args['auth-config']) cfg = loadAuthConfig(args['auth-config']);
  const httpUsername = args['http-username'] || process.env.USEO_HTTP_USERNAME || cfg.httpUsername || '';
  const httpPassword = args['http-password'] || process.env.USEO_HTTP_PASSWORD || cfg.httpPassword || '';
  const loginUrl = args['login-url'] || cfg.loginUrl || '';
  const username = args['username'] || process.env.USEO_LOGIN_USERNAME || cfg.username || '';
  const password = args['password'] || process.env.USEO_LOGIN_PASSWORD || cfg.password || '';
  const usernameSelector = args['username-selector'] || cfg.usernameSelector || "input[name='username'], input[type='email']";
  const passwordSelector = args['password-selector'] || cfg.passwordSelector || "input[name='password'], input[type='password']";
  const submitSelector = args['submit-selector'] || cfg.submitSelector || "button[type='submit'], input[type='submit']";
  const readySelector = args['ready-selector'] || cfg.readySelector || '';
  const postLoginWaitMs = Number(args['post-login-wait-ms'] || cfg.postLoginWaitMs || 2000);
  return {
    httpCredentials: httpUsername || httpPassword ? { username: httpUsername, password: httpPassword } : null,
    formAuth: loginUrl && username ? { loginUrl, username, password, usernameSelector, passwordSelector, submitSelector, readySelector, postLoginWaitMs } : null,
  };
}
async function maybePerformFormLogin(page, formAuth, slowMode = false) {
  if (!formAuth) return false;
  statusMsg('🔐', c.cyan, `Attempting form login at ${formAuth.loginUrl}`);
  await page.goto(formAuth.loginUrl, { waitUntil: slowMode ? 'domcontentloaded' : 'networkidle', timeout: 90000 });
  await page.locator(formAuth.usernameSelector).first().fill(formAuth.username);
  await page.locator(formAuth.passwordSelector).first().fill(formAuth.password || '');
  if (formAuth.submitSelector) {
    await Promise.allSettled([
      page.waitForLoadState(slowMode ? 'domcontentloaded' : 'networkidle', { timeout: 20000 }),
      page.locator(formAuth.submitSelector).first().click(),
    ]);
  } else {
    await page.keyboard.press('Enter');
    await page.waitForLoadState(slowMode ? 'domcontentloaded' : 'networkidle', { timeout: 20000 }).catch(() => {});
  }
  if (formAuth.readySelector) await page.locator(formAuth.readySelector).first().waitFor({ state: 'visible', timeout: 20000 });
  else await page.waitForTimeout(formAuth.postLoginWaitMs || 2000);
  statusMsg('🔐', c.brightGreen, 'Form login step completed.');
  return true;
}
async function gotoWithRetry(page, url, opts = {}) {
  const { slow = false, retries = 1, backoffMs = 3000, timeoutMs = 90000, cfAware = false } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: slow ? 'domcontentloaded' : 'networkidle', timeout: timeoutMs });
      await page.waitForTimeout(slow ? 2000 : 800);
      const bot = cfAware ? detectBotChallengeHtml(await page.content(), response?.status?.() || 0) : { detected: false, type: '', status: 0 };
      if (bot.detected) {
        lastErr = new Error(`bot_protection:${bot.type}`);
        if (attempt < retries) {
          const delay = backoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
          statusMsg('⚠', c.brightYellow, `Bot protection detected (${bot.type}, status ${bot.status}) on ${decodeUrlForDisplay(url)}. Backing off ${Math.ceil(delay / 1000)}s then retrying...`);
          await sleep(delay);
          continue;
        }
        throw lastErr;
      }
      return { response, bot };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const delay = backoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
        statusMsg('⚠', c.brightYellow, `Navigation failed for ${decodeUrlForDisplay(url)} (${String(e?.message || e)}). Backing off ${Math.ceil(delay / 1000)}s then retrying...`);
        await sleep(delay);
      }
    }
  }
  throw lastErr || new Error('navigation_failed');
}

// ════════════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════════════
const args = parseArgs(process.argv);
if (!args.site) {
  console.error('Missing --site');
  process.exit(1);
}
const site = args.site;
const maxPages = args['max-pages'] ? Number(args['max-pages']) : null;
const runLighthouse = Boolean(args['lighthouse']);
const maxLinkChecks = args['max-link-checks'] ? Number(args['max-link-checks']) : 250;
const slowMode = Boolean(args['slow']);
const cfAware = Boolean(args['cloudflare-aware']);
const respectRobots = Boolean(args['respect-robots']);
const retries = args['retries'] ? Number(args['retries']) : (slowMode ? 2 : 1);
const backoffMs = args['backoff-ms'] ? Number(args['backoff-ms']) : (slowMode ? 8000 : 3000);
const auth = getAuthSettings(args);
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
if (slowMode) statusMsg('🐢', c.cyan, 'Running in --slow mode (conservative scan: longer waits + retries).');
if (cfAware) statusMsg('🛡️', c.cyan, 'Cloudflare-aware challenge detection enabled (--cloudflare-aware).');
if (respectRobots) statusMsg('🤖', c.cyan, 'Respecting robots.txt Disallow rules (--respect-robots).');
if (auth.httpCredentials || auth.formAuth) statusMsg('🔐', c.cyan, 'Authenticated mode enabled for protected/staging/dev sites.');

phaseHeader('Phase 1: Setup', '🚀');
const setupStart = Date.now();
const origin = new URL(site).origin;
const canonicalHost = new URL(site).host;
let robotsCfg = { isAllowedUrl: null, crawlDelayMs: 0 };
if (respectRobots) robotsCfg = await buildRobotsMatcher(site);
const crawlDelayMs = args['crawl-delay-ms'] ? Number(args['crawl-delay-ms']) : (robotsCfg.crawlDelayMs || (slowMode ? 1500 : 0));
if (crawlDelayMs > 0) statusMsg('⏳', c.cyan, `Using crawl delay: ${Math.ceil(crawlDelayMs / 1000)}s between pages.`);
statusMsg('◐', c.cyan, 'Launching headless browser...');
const browser = await chromium.launch({ headless: true });
const contextOptions = { userAgent: 'Universal-SEO-Audit (Playwright)' };
if (auth.httpCredentials) contextOptions.httpCredentials = auth.httpCredentials;
let context = await browser.newContext(contextOptions);
await installWebMcpCapture(context);
let page = await context.newPage();
if (auth.formAuth) await maybePerformFormLogin(page, auth.formAuth, slowMode);
phaseDone('Browser ready', Date.now() - setupStart);

phaseHeader('Phase 2: URL discovery', '🗺️');
const discoveryStart = Date.now();
let discoveredUrls = [];
let sitemapFileUrls = [];
if (args['urls-file']) {
  discoveredUrls = fs.readFileSync(path.resolve(args['urls-file']), 'utf8').split(/\r?\n/g).map((s) => s.trim()).filter(Boolean).map(normalizeUrl);
  if (maxPages) discoveredUrls = discoveredUrls.slice(0, maxPages);
  statusMsg('📄', c.cyan, `URL file: ${c.bold}${args['urls-file']}${c.reset} ${c.dim}(${discoveredUrls.length} URLs)${c.reset}`);
} else if (!args['crawl']) {
  try {
    statusMsg('◐', c.cyan, 'Fetching sitemap...');
    const sitemapResult = await discoverUrlsFromSitemap(site, args);
    discoveredUrls = sitemapResult.pages;
    sitemapFileUrls = sitemapResult.files;
    statusMsg('🌐', c.brightGreen, `Found ${c.bold}${discoveredUrls.length}${c.reset} URL(s) from sitemap`);
    if (sitemapFileUrls.length) statusMsg('📎', c.dim, `${c.bold}${sitemapFileUrls.length}${c.reset} non-page file(s) from the sitemap (PDFs, docs, images, etc.) will be checked as assets, not scanned as pages.`);
    fs.writeFileSync(path.join(outDir, 'urls.txt'), discoveredUrls.join('\n') + '\n', 'utf8');
  } catch (e) {
    statusMsg('⚠', c.brightYellow, 'Sitemap discovery failed. Falling back to browser crawl.');
    discoveredUrls = [normalizeUrl(site)];
  }
} else {
  discoveredUrls = [normalizeUrl(site)];
  statusMsg('🕷️', c.cyan, 'Browser crawl mode');
  if (!args['crawl-assets']) {
    statusMsg('🖼️', c.dim, `Media/asset links (images, PDFs, etc.) are checked but not crawled as pages. Use ${c.bold}--crawl-assets${c.reset} to include them.`);
  }
}
if (robotsCfg.isAllowedUrl) {
  const beforeCount = discoveredUrls.length;
  discoveredUrls = discoveredUrls.filter((u) => robotsCfg.isAllowedUrl(u));
  if (discoveredUrls.length < beforeCount) statusMsg('🤖', c.dim, `Filtered ${beforeCount - discoveredUrls.length} URL(s) disallowed by robots.txt.`);
}
if (runLighthouse && discoveredUrls.length > 50 && !maxPages) {
  statusMsg('⚠', c.brightYellow, `Lighthouse enabled for ${c.bold}${discoveredUrls.length}${c.reset}${c.brightYellow} URLs — this will take a while. Use --max-pages 10 for a sample.${c.reset}`);
}
let totalPages = maxPages ? Math.min(maxPages, discoveredUrls.length) : discoveredUrls.length;
const estPerPage = runLighthouse ? 25000 : 8000;
const estTotal = totalPages * estPerPage;
statusMsg('⏱️', c.brightMagenta, `Estimated: ${c.bold}~${formatDuration(estTotal)}${c.reset} ${c.dim}(${totalPages} page${totalPages === 1 ? '' : 's'}${runLighthouse ? ' + Lighthouse' : ''}${args['crawl'] ? ', more discovered as crawl proceeds' : ''})${c.reset}`);
phaseDone('URL discovery', Date.now() - discoveryStart);

// ── Phase 3: Page scanning ─────────────────────────────────────────────
phaseHeader('Phase 3: Page scanning', '🔍');
const scanStart = Date.now();
let lighthouseChrome = null;
if (runLighthouse) {
  lighthouseChrome = await launchLighthouseChrome();
}
const pageTimes = [];
const queue = [...discoveredUrls];
const seenPages = new Set();
const seenAssets = new Set();
const pageRows = [];
const assetRows = [];
const issueRows = [];
const imageRows = [];
const socialRows = [];
const structuredRows = [];
const lighthouseRows = [];
const agenticRows = [];
const scriptRows = [];
const crawlRows = [];
const sectionMap = new Map();
const hostMap = new Map();
const titleMap = new Map();
const descMap = new Map();
const pageLinksMap = new Map();
const uniqueLinks = new Map();

if (sitemapFileUrls.length) {
  statusMsg('📎', c.cyan, `Checking ${c.bold}${sitemapFileUrls.length}${c.reset} non-page file(s) from the sitemap...`);
  let fileChecked = 0;
  for (const fileUrl of sitemapFileUrls) {
    fileChecked++;
    if (fileChecked % 25 === 0 || fileChecked === sitemapFileUrls.length) progressLine(fileChecked, sitemapFileUrls.length, 'sitemap files checked');
    if (seenAssets.has(fileUrl)) continue;
    seenAssets.add(fileUrl);
    const checked = await checkAsset(fileUrl, canonicalHost);
    const type = classifyAssetType(fileUrl, 'a', '');
    assetRows.push({
      page_url: site, asset_url: fileUrl, asset_type: type, source: 'sitemap',
      status_code: checked.status, final_url: checked.final_url || '', asset_host: checked.original_host || '',
      final_host: checked.final_host || '', ok: checked.ok ? 'yes' : 'no', broken: checked.ok ? 'no' : 'yes',
      host_mismatch: checked.host_mismatch || 'no', www_mismatch: checked.www_mismatch || 'no',
      non_canonical_host: checked.non_canonical_host || 'no', staging_production_mixup: checked.staging_production_mixup || 'no',
      protocol_mismatch: checked.protocol_mismatch || 'no', content_type: checked.content_type || ''
    });
    if (!checked.ok) {
      issueRows.push({ page_url: fileUrl, issue_type: 'broken_sitemap_file', severity: 'high', details: `Sitemap-listed file returned ${checked.status || 'network error'}: ${fileUrl}` });
    }
  }
  console.log('');
}

while (queue.length && (!maxPages || seenPages.size < maxPages)) {
  const url = queue.shift();
  if (seenPages.has(url)) continue;
  seenPages.add(url);
  const issueRowsStartIdx = issueRows.length;
  if (seenPages.size > 1 && seenPages.size % 25 === 1) {
    await context.close();
    context = await browser.newContext(contextOptions);
    await installWebMcpCapture(context);
    page = await context.newPage();
    if (auth.formAuth) await maybePerformFormLogin(page, auth.formAuth, slowMode);
  }
  const pageStart = Date.now();
  const pageNum = seenPages.size;
  const avgMs = pageTimes.length > 0 ? pageTimes.reduce((a, b) => a + b, 0) / pageTimes.length : estPerPage;
  const remaining = totalPages - pageNum;
  const eta = remaining > 0 ? formatDuration(remaining * avgMs) : '0s';
  const shortUrl = url.length > 55 ? url.slice(0, 52) + '...' : url;
  progressLine(pageNum, totalPages, shortUrl, `${c.dim}ETA:${c.reset} ${c.brightYellow}~${eta}${c.reset}`, false);
  let status = 0;
  let responseHeaders = {};
  try {
    const nav = await gotoWithRetry(page, url, { slow: slowMode, retries, backoffMs, timeoutMs: 90000, cfAware });
    status = nav.response?.status?.() || 0;
    responseHeaders = nav.response?.headers?.() || {};
  } catch (navError) {
    status = 0;
    if (String(navError?.message || '').startsWith('bot_protection:')) {
      issueRows.push({ page_url: url, issue_type: 'bot_protection_blocked', severity: 'critical', details: `Navigation blocked by bot protection: ${String(navError.message)}. Retry with --slow --cloudflare-aware, or use --urls-file with a manually saved URL list.` });
    }
  }
  if (crawlDelayMs > 0) await sleep(crawlDelayMs);

  let data;
  try {
    data = await extractFullPageData(page);
  } catch (evaluateError) {
    console.warn(`Warning: DOM extraction failed for ${url}. Retrying after reload. ${evaluateError?.message || evaluateError}`);
    try {
      const retryRes = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      status = retryRes?.status?.() || status;
      responseHeaders = retryRes?.headers?.() || responseHeaders;
      await page.waitForTimeout(750);
      data = await extractFullPageData(page);
    } catch (retryError) {
      console.warn(`Warning: Skipping DOM extraction for ${url}. ${retryError?.message || retryError}`);
      issueRows.push({ page_url: url, issue_type: 'page_extraction_error', severity: 'high', details: retryError?.message || String(retryError) });
      pageRows.push({ page_url: url, title: '', status_code: status, asset_count: 0, section: getSection(url), canonical_count: 0, canonical: '', canonical_status: '', meta_description: '', h1_count: 0, h1_text: '', word_count: 0, heading_outline: '', internal_link_count: 0, external_link_count: 0, image_count: 0, hreflang_count: 0, jsonld_count: 0, dom_node_count: 0, resource_count: 0, issue_count: 0 });
      pageTimes.push(Date.now() - pageStart);
      continue;
    }
  }

  const finalUrl = normalizeUrl(url);
  const title = normalizeWhitespace(data.title);
  const desc = normalizeWhitespace(data.meta_description);
  const robotsMeta = normalizeWhitespace(data.robots_meta);
  const xRobotsTag = responseHeaders['x-robots-tag'] || '';

  // ── Crawl discovery ──────────────────────────────────────────────────
  const linksForPage = [];
  for (const l of data.links) {
    try {
      const abs = normalizeUrl(new URL(l.href, url).toString());
      if (/^(mailto:|tel:|javascript:)/i.test(abs)) continue;
      const kind = sameOrigin(abs, origin) ? 'internal' : 'external';
      linksForPage.push({ href: abs, kind, anchor_text: normalizeWhitespace(l.text) });
      if (kind === 'internal' && args['crawl'] && (args['crawl-assets'] || isCrawlablePage(abs)) && !seenPages.has(abs) && !queue.includes(abs) && (!maxPages || queue.length + seenPages.size < maxPages) && (!robotsCfg.isAllowedUrl || robotsCfg.isAllowedUrl(abs))) {
        queue.push(abs);
        totalPages++;
      }
      if (!uniqueLinks.has(abs) && uniqueLinks.size < maxLinkChecks) uniqueLinks.set(abs, kind);
    } catch {}
  }
  pageLinksMap.set(url, linksForPage);
  const internalLinkCount = linksForPage.filter((l) => l.kind === 'internal').length;
  const externalLinkCount = linksForPage.filter((l) => l.kind === 'external').length;

  // ── Asset checking ───────────────────────────────────────────────────
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

  // ── Canonical & hreflang ─────────────────────────────────────────────
  const section = getSection(url);
  const canonical = (data.canonicals && data.canonicals[0]) ? normalizeUrl(data.canonicals[0]) : '';
  const canonical_count = (data.canonicals || []).length;
  const cStatus = canonicalStatus(url, canonical, canonical_count);
  const hreflang_count = (data.hreflangs || []).length;
  const hreflangValidation = validateHreflangs(data.hreflangs || []);
  const hreflang_values = (data.hreflangs || []).map((h) => `${h.hreflang}:${h.href}`).join(' | ');

  if (!canonical) issueRows.push({ page_url: url, issue_type: 'canonical_missing', severity: 'medium', details: 'Missing canonical tag.' });
  if (canonical_count > 1) issueRows.push({ page_url: url, issue_type: 'canonical_duplicate', severity: 'high', details: `Found ${canonical_count} canonical tags: ${(data.canonicals || []).join(' | ')}` });
  if (cStatus === 'cross_domain') issueRows.push({ page_url: url, issue_type: 'canonical_cross_domain', severity: 'high', details: `Canonical points to another domain: ${canonical}` });
  if (cStatus === 'mismatch') issueRows.push({ page_url: url, issue_type: 'canonical_mismatch', severity: 'medium', details: `Canonical does not match crawled URL: ${canonical}` });
  if (cStatus === 'invalid') issueRows.push({ page_url: url, issue_type: 'canonical_invalid', severity: 'high', details: `Canonical URL could not be parsed: ${canonical}` });

  if (hreflang_count === 0) issueRows.push({ page_url: url, issue_type: 'hreflang_missing', severity: 'low', details: 'No hreflang tags found. This is only an issue for multilingual or multi-region sites.' });
  if (hreflangValidation.invalid > 0) issueRows.push({ page_url: url, issue_type: 'hreflang_invalid', severity: 'medium', details: `${hreflangValidation.invalid} hreflang tag(s) are missing hreflang or href values.` });
  if (hreflangValidation.duplicates > 0) issueRows.push({ page_url: url, issue_type: 'hreflang_duplicate', severity: 'medium', details: `${hreflangValidation.duplicates} duplicate hreflang value(s) found.` });

  // ── HTTP status issues ───────────────────────────────────────────────
  if (status >= 400 && status < 500) issueRows.push({ page_url: url, issue_type: 'http_4xx', severity: 'critical', details: `Page returned HTTP ${status}.` });
  if (status >= 500) issueRows.push({ page_url: url, issue_type: 'http_5xx', severity: 'critical', details: `Page returned HTTP ${status}.` });
  if (status >= 300 && status < 400) issueRows.push({ page_url: url, issue_type: 'redirect_page', severity: 'medium', details: `Page returned redirect status ${status}.` });

  // ── Title checks ─────────────────────────────────────────────────────
  if (!title) issueRows.push({ page_url: url, issue_type: 'missing_title', severity: 'high', details: 'Missing <title> tag.' });
  else {
    if (data.title_length > 60) issueRows.push({ page_url: url, issue_type: 'title_too_long', severity: 'medium', details: `Title length is ${data.title_length}.` });
    if (data.title_length < 10) issueRows.push({ page_url: url, issue_type: 'title_too_short', severity: 'medium', details: `Title length is ${data.title_length}.` });
  }
  if (title) {
    const key = title.toLowerCase();
    if (!titleMap.has(key)) titleMap.set(key, new Set());
    titleMap.get(key).add(url);
  }

  // ── Meta description checks ──────────────────────────────────────────
  if (!desc) issueRows.push({ page_url: url, issue_type: 'missing_meta_description', severity: 'medium', details: 'Missing meta description.' });
  else {
    if (data.meta_description_length > 160) issueRows.push({ page_url: url, issue_type: 'meta_description_too_long', severity: 'low', details: `Meta description length is ${data.meta_description_length}.` });
    if (data.meta_description_length < 50) issueRows.push({ page_url: url, issue_type: 'meta_description_too_short', severity: 'low', details: `Meta description length is ${data.meta_description_length}.` });
  }
  if (desc) {
    const key = desc.toLowerCase();
    if (!descMap.has(key)) descMap.set(key, new Set());
    descMap.get(key).add(url);
  }

  // ── Robots / indexability ────────────────────────────────────────────
  if (!data.robots_indexable) issueRows.push({ page_url: url, issue_type: 'noindex_present', severity: 'medium', details: `Robots meta contains noindex: ${robotsMeta || 'noindex'}.` });
  if (!data.robots_followable) issueRows.push({ page_url: url, issue_type: 'nofollow_present', severity: 'low', details: `Robots meta contains nofollow: ${robotsMeta || 'nofollow'}.` });
  if (/noindex/i.test(xRobotsTag)) issueRows.push({ page_url: url, issue_type: 'noindex_header', severity: 'medium', details: `X-Robots-Tag contains noindex: ${xRobotsTag}` });

  // ── Viewport / lang / structured data ────────────────────────────────
  if (!normalizeWhitespace(data.viewport_meta)) issueRows.push({ page_url: url, issue_type: 'missing_viewport', severity: 'medium', details: 'Missing viewport meta tag.' });
  if (!normalizeWhitespace(data.html_lang)) issueRows.push({ page_url: url, issue_type: 'missing_lang', severity: 'medium', details: 'Missing html lang attribute.' });
  if (Number(data.jsonld_invalid_count || 0) > 0) issueRows.push({ page_url: url, issue_type: 'invalid_jsonld', severity: 'medium', details: `${data.jsonld_invalid_count} JSON-LD block(s) could not be parsed.` });
  if (Number(data.jsonld_count || 0) === 0) issueRows.push({ page_url: url, issue_type: 'missing_schema', severity: 'medium', details: 'No JSON-LD structured data found on this page.' });

  // ── H1 checks ────────────────────────────────────────────────────────
  if (Number(data.h1_count || 0) === 0) issueRows.push({ page_url: url, issue_type: 'h1_missing', severity: 'high', details: 'No H1 found on the page.' });
  if (Number(data.h1_count || 0) > 1) issueRows.push({ page_url: url, issue_type: 'multiple_h1', severity: 'medium', details: `Found ${data.h1_count} H1 elements.` });

  // ── Thin content ─────────────────────────────────────────────────────
  if (Number(data.word_count || 0) > 0 && Number(data.word_count) < 150) issueRows.push({ page_url: url, issue_type: 'thin_content', severity: 'medium', details: `Word count is ${data.word_count}.` });

  // ── DOM / resource weight ────────────────────────────────────────────
  if (Number(data.dom_node_count || 0) > 1500) issueRows.push({ page_url: url, issue_type: 'heavy_dom', severity: 'low', details: `DOM node count is ${data.dom_node_count}.` });
  if (Number(data.resource_count || 0) > 200) issueRows.push({ page_url: url, issue_type: 'high_resource_count', severity: 'low', details: `Resource count is ${data.resource_count}.` });

  // ── Open Graph / Twitter card checks ─────────────────────────────────
  if (!normalizeWhitespace(data.og_title)) issueRows.push({ page_url: url, issue_type: 'og_title_missing', severity: 'low', details: 'Missing og:title meta tag.' });
  if (!normalizeWhitespace(data.og_description)) issueRows.push({ page_url: url, issue_type: 'og_description_missing', severity: 'low', details: 'Missing og:description meta tag.' });
  if (!normalizeWhitespace(data.og_image)) issueRows.push({ page_url: url, issue_type: 'og_image_missing', severity: 'medium', details: 'Missing og:image meta tag.' });
  if (normalizeWhitespace(data.og_image) && String(data.og_image).startsWith('http://')) issueRows.push({ page_url: url, issue_type: 'og_image_http', severity: 'medium', details: 'og:image uses HTTP instead of HTTPS.' });
  if (normalizeWhitespace(data.og_url)) {
    try {
      if (normalizeUrl(data.og_url) !== normalizeUrl(url)) issueRows.push({ page_url: url, issue_type: 'og_url_mismatch', severity: 'low', details: `og:url does not match page URL: ${data.og_url}` });
    } catch {}
  }
  if (!normalizeWhitespace(data.twitter_card)) issueRows.push({ page_url: url, issue_type: 'twitter_card_missing', severity: 'low', details: 'Missing twitter:card meta tag.' });
  if (!normalizeWhitespace(data.twitter_image)) issueRows.push({ page_url: url, issue_type: 'twitter_image_missing', severity: 'low', details: 'Missing twitter:image meta tag.' });

  // ── Image alt text checks ────────────────────────────────────────────
  let missingAlt = 0, filenameAlt = 0;
  for (const img of data.images) {
    const alt = normalizeWhitespace(img.alt);
    const src = normalizeWhitespace(img.src);
    imageRows.push({
      page_url: url,
      image_url: src,
      alt_text: alt,
      title_text: normalizeWhitespace(img.title),
      alt_present: alt ? 'yes' : 'no',
      alt_looks_like_filename: looksLikeFilename(alt) ? 'yes' : 'no',
    });
    if (!alt) missingAlt++;
    else if (looksLikeFilename(alt)) filenameAlt++;
  }
  if (missingAlt > 0) issueRows.push({ page_url: url, issue_type: 'image_alt_missing', severity: 'medium', details: `${missingAlt} image(s) are missing alt text.` });
  if (filenameAlt > 0) issueRows.push({ page_url: url, issue_type: 'image_alt_filename', severity: 'low', details: `${filenameAlt} image(s) appear to use filename-like alt text.` });

  // ── Structured data row ──────────────────────────────────────────────
  structuredRows.push({
    page_url: url,
    x_robots_tag: xRobotsTag,
    html_lang: normalizeWhitespace(data.html_lang),
    viewport_meta: normalizeWhitespace(data.viewport_meta),
    canonical,
    canonical_status: cStatus,
    hreflang_count,
    hreflang_values,
    jsonld_count: data.jsonld_count,
    jsonld_valid_count: data.jsonld_valid_count,
    jsonld_invalid_count: data.jsonld_invalid_count,
    schema_present: data.jsonld_count > 0 ? 'yes' : 'no',
    schema_valid: data.jsonld_count > 0 && data.jsonld_invalid_count === 0 ? 'yes' : 'no',
    schema_types: data.schema_types,
    dom_node_count: data.dom_node_count,
    script_tag_count: data.script_tag_count,
    stylesheet_count: data.stylesheet_count,
    resource_count: data.resource_count,
  });

  // ── Social meta row ──────────────────────────────────────────────────
  socialRows.push({
    page_url: url,
    final_url: finalUrl,
    title,
    og_title: normalizeWhitespace(data.og_title),
    og_description: normalizeWhitespace(data.og_description),
    og_image: normalizeWhitespace(data.og_image),
    og_url: normalizeWhitespace(data.og_url),
    twitter_card: normalizeWhitespace(data.twitter_card),
    twitter_title: normalizeWhitespace(data.twitter_title),
    twitter_description: normalizeWhitespace(data.twitter_description),
    twitter_image: normalizeWhitespace(data.twitter_image),
  });

  // ── Page row ─────────────────────────────────────────────────────────
  const assetsOnPage = assetRows.length - pageAssetStart;
  pageRows.push({
    page_url: url,
    final_url: finalUrl,
    title,
    title_length: data.title_length,
    meta_description: desc,
    meta_description_length: data.meta_description_length,
    status_code: status,
    robots_meta: robotsMeta,
    x_robots_tag: xRobotsTag,
    indexable: data.robots_indexable ? 'yes' : 'no',
    followable: data.robots_followable ? 'yes' : 'no',
    viewport_meta: data.viewport_meta,
    html_lang: data.html_lang,
    canonical,
    canonical_count,
    canonical_status: cStatus,
    h1_count: data.h1_count,
    h1_text: data.h1_text,
    word_count: data.word_count,
    heading_outline: data.heading_outline,
    og_title: normalizeWhitespace(data.og_title),
    og_description: normalizeWhitespace(data.og_description),
    og_image: normalizeWhitespace(data.og_image),
    og_url: normalizeWhitespace(data.og_url),
    internal_link_count: internalLinkCount,
    external_link_count: externalLinkCount,
    image_count: data.images.length,
    hreflang_present: hreflang_count > 0 ? 'yes' : 'no',
    hreflang_count,
    hreflang_invalid_count: hreflangValidation.invalid,
    hreflang_duplicate_count: hreflangValidation.duplicates,
    hreflang_has_x_default: hreflangValidation.hasXDefault,
    hreflang_values,
    jsonld_count: data.jsonld_count,
    jsonld_invalid_count: data.jsonld_invalid_count,
    schema_types: data.schema_types,
    dom_node_count: data.dom_node_count,
    resource_count: data.resource_count,
    asset_count: assetsOnPage,
    section,
    body_excerpt: data.body_excerpt,
  });
  const sec = sectionMap.get(section) || { section, page_count: 0, asset_count: 0, issue_count: 0 };
  sec.page_count += 1;
  sec.asset_count += assetsOnPage;
  sec.issue_count += issueRows.length - issueRowsStartIdx;
  sectionMap.set(section, sec);

  // ── Lighthouse ───────────────────────────────────────────────────────
  let lighthouseRow = null;
  if (runLighthouse) {
    progressLine(pageNum, totalPages, shortUrl, `${c.brightYellow}⚡ Lighthouse...${c.reset}`, false);
    try {
      lighthouseRow = await runLighthouseAudit(url, { port: lighthouseChrome?.port });
      lighthouseRows.push(lighthouseRow);
      if (Number(lighthouseRow.performance_score || 0) > 0 && Number(lighthouseRow.performance_score) < 50) issueRows.push({ page_url: url, issue_type: 'poor_performance', severity: 'medium', details: `Low Lighthouse performance score: ${lighthouseRow.performance_score}.` });
      if (Number(lighthouseRow.lcp_ms || 0) > 4000) issueRows.push({ page_url: url, issue_type: 'lcp_slow', severity: 'high', details: `Largest Contentful Paint is slow: ${lighthouseRow.lcp_ms}ms.` });
      if (Number(lighthouseRow.cls || 0) > 0.25) issueRows.push({ page_url: url, issue_type: 'cls_high', severity: 'high', details: `Cumulative Layout Shift is high: ${lighthouseRow.cls}.` });
      if (Number(lighthouseRow.tbt_ms || 0) > 300) issueRows.push({ page_url: url, issue_type: 'tbt_high', severity: 'medium', details: `Total Blocking Time is high: ${lighthouseRow.tbt_ms}ms.` });
    } catch (e) {
      lighthouseRow = { url, page_url: url, final_url: url, lighthouse_available: 'no', performance: '', performance_score: '', lcp: '', lcp_ms: '', cls: '', tbt: '', tbt_ms: '', fcp: '', fcp_ms: '', si_ms: '', error: String(e), note: String(e) };
      lighthouseRows.push(lighthouseRow);
    }
  }

  // ── Agentic signals ──────────────────────────────────────────────────
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

  // ── Script inventory / CSP ───────────────────────────────────────────
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

  // ── Per-page summary ─────────────────────────────────────────────────
  const pageElapsed = Date.now() - pageStart;
  pageTimes.push(pageElapsed);
  const issuesOnPage = issueRows.length - issueRowsStartIdx;
  const issueIcon = issuesOnPage === 0 ? `${c.brightGreen}✔${c.reset}` : issuesOnPage > 5 ? `${c.brightRed}✖${c.reset}` : `${c.brightYellow}●${c.reset}`;
  console.log(`\r\x1b[K  ${issueIcon} ${c.dim}[${pageNum}/${totalPages}]${c.reset} ${c.brightCyan}${formatDuration(pageElapsed)}${c.reset} ${c.dim}│${c.reset} ${c.white}${assetsOnPage}${c.reset} assets ${c.dim}│${c.reset} ${severityColor(issuesOnPage, 5)} issues ${c.dim}│${c.reset} ${c.dim}${shortUrl}${c.reset}`);
}

console.log('');
phaseDone(`Scanned ${c.bold}${seenPages.size}${c.reset} pages`, Date.now() - scanStart);
statusMsg('📊', c.brightCyan, `Total: ${severityColor(issueRows.length, 20)} issues, ${c.bold}${assetRows.length}${c.reset} assets checked`);

await closeLighthouseChrome();
await browser.close();

// ── Post-scan: duplicate titles/descriptions ───────────────────────────
for (const [titleKey, pages] of titleMap.entries()) {
  if (!titleKey || pages.size < 2) continue;
  const list = Array.from(pages).slice(0, 10);
  for (const pageUrl of list) issueRows.push({ page_url: pageUrl, issue_type: 'duplicate_title', severity: 'high', details: `Title is duplicated across ${pages.size} pages. Example pages: ${list.join(' | ')}` });
}
for (const [descKey, pages] of descMap.entries()) {
  if (!descKey || pages.size < 2) continue;
  const list = Array.from(pages).slice(0, 10);
  for (const pageUrl of list) issueRows.push({ page_url: pageUrl, issue_type: 'duplicate_meta_description', severity: 'medium', details: `Meta description is duplicated across ${pages.size} pages. Example pages: ${list.join(' | ')}` });
}

// ── Post-scan: link validation ─────────────────────────────────────────
if (uniqueLinks.size > 0) {
  phaseHeader('Phase 3b: Link validation', '🔗');
  const linkStart = Date.now();
  statusMsg('◐', c.cyan, `Checking up to ${c.bold}${uniqueLinks.size}${c.reset} unique links...`);
  const linkStatuses = new Map();
  let checked = 0;
  for (const href of uniqueLinks.keys()) {
    checked++;
    if (checked % 25 === 0 || checked === uniqueLinks.size) progressLine(checked, uniqueLinks.size, 'links checked');
    linkStatuses.set(href, await checkLink(href));
  }
  console.log('\r\x1b[K');
  for (const [pageUrl, links] of pageLinksMap.entries()) {
    for (const link of links.slice(0, 50)) {
      const res = linkStatuses.get(link.href);
      if (!res) continue;
      if (res.status >= 400 || (!res.ok && res.status === 0)) {
        if (link.kind === 'internal') issueRows.push({ page_url: pageUrl, issue_type: 'broken_internal_link', severity: 'high', details: `Broken internal link: ${link.href} (${res.status || 'network error'})` });
        else issueRows.push({ page_url: pageUrl, issue_type: 'broken_external_link', severity: 'medium', details: `Broken external link: ${link.href} (${res.status || 'network error'})` });
      }
    }
  }
  phaseDone('Link validation', Date.now() - linkStart);
}

// ── Post-scan: duplicate content clustering ────────────────────────────
const contentCandidates = pageRows
  .map((p) => ({ page_url: p.page_url, word_count: Number(p.word_count || 0), body_excerpt: p.body_excerpt || '' }))
  .filter((p) => p.word_count >= 150 && p.body_excerpt);
const usedInCluster = new Set();
const limit = Math.min(contentCandidates.length, 120);
for (let i = 0; i < limit; i++) {
  if (usedInCluster.has(contentCandidates[i].page_url)) continue;
  const a = contentCandidates[i];
  const aSet = tokenSet(a.body_excerpt);
  const cluster = [a.page_url];
  for (let j = i + 1; j < limit; j++) {
    const b = contentCandidates[j];
    if (usedInCluster.has(b.page_url)) continue;
    const sim = jaccardSimilarity(aSet, tokenSet(b.body_excerpt));
    if (sim >= 0.82) {
      cluster.push(b.page_url);
      usedInCluster.add(b.page_url);
    }
  }
  if (cluster.length > 1) {
    for (const pageUrl of cluster) {
      issueRows.push({ page_url: pageUrl, issue_type: 'duplicate_content_cluster', severity: 'medium', details: `Page body content is highly similar to ${cluster.length - 1} other page(s). Cluster sample: ${cluster.slice(0, 5).join(' | ')}` });
    }
  }
}

// ── Post-scan: crawl analysis (link depth + orphan candidates) ─────────
const scannedUrls = [...seenPages];
const adjacency = new Map();
const inlinks = new Map();
for (const u of scannedUrls) { adjacency.set(u, []); inlinks.set(u, 0); }
for (const [pageUrl, links] of pageLinksMap.entries()) {
  for (const link of links) {
    if (link.kind !== 'internal') continue;
    const target = normalizeUrl(link.href);
    if (!seenPages.has(target)) continue;
    adjacency.get(pageUrl)?.push(target);
    inlinks.set(target, (inlinks.get(target) || 0) + 1);
  }
}
const depth = new Map();
if (scannedUrls.length) {
  const bfsQueue = [scannedUrls[0]];
  depth.set(scannedUrls[0], 0);
  while (bfsQueue.length) {
    const node = bfsQueue.shift();
    for (const target of adjacency.get(node) || []) {
      if (!depth.has(target)) {
        depth.set(target, depth.get(node) + 1);
        bfsQueue.push(target);
      }
    }
  }
}
for (const u of scannedUrls) {
  const urlInlinks = inlinks.get(u) || 0;
  const urlDepth = depth.has(u) ? depth.get(u) : '';
  crawlRows.push({
    page_url: u,
    final_url: pageRows.find((p) => p.page_url === u)?.final_url || u,
    status_code: pageRows.find((p) => p.page_url === u)?.status_code || '',
    section: getSection(u),
    inlinks: urlInlinks,
    internal_link_depth: urlDepth,
    orphan_candidate: u !== scannedUrls[0] && urlInlinks === 0 ? 'yes' : 'no',
    crawl_discovered: urlDepth === '' ? 'no' : 'yes',
    sitemap_only_candidate: u !== scannedUrls[0] && urlDepth === '' ? 'yes' : 'no',
  });
  if (u !== scannedUrls[0] && urlInlinks === 0) {
    issueRows.push({ page_url: u, issue_type: 'orphan_candidate', severity: 'medium', details: 'Page has zero internal inlinks within the scanned set and may be an orphan candidate.' });
  }
}

// ── CDN inconsistency ──────────────────────────────────────────────────
const externalHosts = assetRows.filter((r) => r.asset_host && r.asset_host !== canonicalHost).map((r) => r.final_host || r.asset_host);
const uniqueExternalHosts = [...new Set(externalHosts)];
if (uniqueExternalHosts.length > 1) {
  issueRows.push({ page_url: site, issue_type: 'cdn_inconsistency', severity: 'medium', details: `Multiple external asset hosts detected: ${uniqueExternalHosts.join(' | ')}` });
}

// ── Issue counts per page ──────────────────────────────────────────────
const issueCounts = issueRows.reduce((acc, row) => { acc[row.page_url] = (acc[row.page_url] || 0) + 1; return acc; }, {});
for (const p of pageRows) p.issue_count = issueCounts[p.page_url] || 0;

// ════════════════════════════════════════════════════════════════════════
// Phase 4: Report generation
// ════════════════════════════════════════════════════════════════════════
phaseHeader('Phase 4: Report generation', '📝');
const reportStart = Date.now();
statusMsg('💾', c.cyan, 'Writing CSV data files...');

writeCsv(path.join(outDir, 'seo-pages.csv'),
  ['page_url','final_url','title','title_length','meta_description','meta_description_length','status_code','robots_meta','x_robots_tag','indexable','followable','viewport_meta','html_lang','canonical','canonical_count','canonical_status','h1_count','h1_text','word_count','heading_outline','og_title','og_description','og_image','og_url','internal_link_count','external_link_count','image_count','hreflang_present','hreflang_count','hreflang_invalid_count','hreflang_duplicate_count','hreflang_has_x_default','hreflang_values','jsonld_count','jsonld_invalid_count','schema_types','dom_node_count','resource_count','asset_count','section','issue_count'],
  pageRows.map(({ body_excerpt, ...rest }) => rest));

writeCsv(path.join(outDir, 'seo-assets.csv'),
  ['page_url','asset_url','asset_type','source','status_code','final_url','asset_host','final_host','ok','broken','host_mismatch','www_mismatch','non_canonical_host','staging_production_mixup','protocol_mismatch','content_type'],
  assetRows);

writeCsv(path.join(outDir, 'seo-issues.csv'),
  ['page_url','issue_type','severity','details'],
  issueRows);

writeCsv(path.join(outDir, 'seo-images.csv'),
  ['page_url','image_url','alt_text','title_text','alt_present','alt_looks_like_filename'],
  imageRows);

writeCsv(path.join(outDir, 'seo-social.csv'),
  ['page_url','final_url','title','og_title','og_description','og_image','og_url','twitter_card','twitter_title','twitter_description','twitter_image'],
  socialRows);

writeCsv(path.join(outDir, 'seo-structured-data.csv'),
  ['page_url','x_robots_tag','html_lang','viewport_meta','canonical','canonical_status','hreflang_count','hreflang_values','jsonld_count','jsonld_valid_count','jsonld_invalid_count','schema_present','schema_valid','schema_types','dom_node_count','script_tag_count','stylesheet_count','resource_count'],
  structuredRows);

writeCsv(path.join(outDir, 'seo-crawl-analysis.csv'),
  ['page_url','final_url','status_code','section','inlinks','internal_link_depth','orphan_candidate','crawl_discovered','sitemap_only_candidate'],
  crawlRows);

writeCsv(path.join(outDir, 'seo-section-summary.csv'),
  ['section','page_count','asset_count','issue_count'],
  Array.from(sectionMap.values()));

writeCsv(path.join(outDir, 'seo-asset-host-summary.csv'),
  ['host','count'],
  Array.from(hostMap.entries()).sort((a, b) => b[1] - a[1]).map(([host, count]) => ({ host, count })));

if (runLighthouse) writeCsv(path.join(outDir, 'seo-lighthouse.csv'),
  ['url','page_url','final_url','lighthouse_available','performance','performance_score','lcp','lcp_ms','cls','tbt','tbt_ms','fcp','fcp_ms','si_ms','note'],
  lighthouseRows);

writeCsv(path.join(outDir, 'seo-agentic.csv'),
  ['page_url','agentic_score','agentic_grade','webmcp_protocol_score','webmcp_tools_registered','webmcp_tools_with_schema','webmcp_reference_count','webmcp_tool_names','accessibility_tree_score','form_control_count','named_form_control_count','clickable_count','named_clickable_count','semantic_data_score','llms_txt_present','llms_txt_url','llms_txt_status','llms_txt_bytes','llms_txt_headings','llms_txt_links','layout_stability_score','cls','visible_image_count','images_with_dimensions_count','note'],
  agenticRows);

writeCsv(path.join(outDir, 'seo-scripts.csv'),
  ['page_url','external_script_count','inline_script_count','total_script_count','inline_event_handler_count','javascript_link_count','first_party_script_domains','first_party_script_count','third_party_script_domains','third_party_script_count','unique_script_domains','uses_eval','uses_document_write','uses_innerhtml','all_inline_have_nonce','all_external_have_integrity','async_script_count','defer_script_count','render_blocking_script_count','needs_unsafe_inline','needs_unsafe_eval','suggested_script_src'],
  scriptRows);

const cspSummary = buildCspSummary(scriptRows, origin);
writeCsv(path.join(outDir, 'seo-csp-summary.csv'),
  ['pages_audited','total_external_scripts','total_inline_scripts','total_inline_event_handlers','total_javascript_links','total_render_blocking','unique_third_party_domains','third_party_domains','needs_unsafe_inline','needs_unsafe_eval','pages_with_eval','pages_with_document_write','suggested_script_src'],
  [cspSummary]);

// JSON report
const byIssueType = issueRows.reduce((acc, row) => { acc[row.issue_type] = (acc[row.issue_type] || 0) + 1; return acc; }, {});
fs.writeFileSync(path.join(outDir, 'seo-report.json'), JSON.stringify({
  runId: path.basename(outDir),
  scanned: scannedUrls,
  pages: pageRows.map(({ body_excerpt, ...rest }) => rest),
  issues: issueRows,
  images: imageRows,
  structured: structuredRows,
  social: socialRows,
  agentic: agenticRows,
}, null, 2));

fs.writeFileSync(path.join(outDir, 'seo-run-metadata.json'), JSON.stringify({
  runId: path.basename(outDir),
  startedAt: new Date(auditStartTime).toISOString(),
  finishedAt: new Date().toISOString(),
  pagesScanned: seenPages.size,
  issuesFound: issueRows.length,
  assetsScanned: assetRows.length,
  imagesScanned: imageRows.length,
  structuredRows: structuredRows.length,
  socialRows: socialRows.length,
  crawlRows: crawlRows.length,
  agenticRows: agenticRows.length,
  lighthouseRows: runLighthouse ? lighthouseRows.length : 0,
  byIssueType,
  topIssueTypes: Object.entries(byIssueType).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([issue_type, count]) => ({ issue_type, count })),
}, null, 2));

if (!args['no-visual-report']) {
  statusMsg('🎨', c.cyan, 'Generating visual dashboard and PDF report...');
  const visualArgs = [path.resolve('scripts/generate-visual-report.mjs'), '--run-dir', outDir, '--site', site];
  if (args['brand-config']) visualArgs.push('--brand-config', args['brand-config']);
  const visual = spawnSync(process.execPath, visualArgs, { stdio: 'inherit' });
  if (visual.status !== 0) statusMsg('⚠', c.brightYellow, 'Visual report generation failed.');
}
phaseDone('Reports written', Date.now() - reportStart);

// ── Summary ────────────────────────────────────────────────────────────
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
console.log(`  ${c.brightCyan}🖼️${c.reset}  ${c.bold}Images${c.reset}      ${c.brightGreen}${imageRows.length}${c.reset}`);
console.log(`  ${c.brightCyan}⚠️${c.reset}  ${c.bold}Issues${c.reset}      ${severityColor(issueRows.length, 20)}`);
console.log(`  ${c.brightCyan}📜${c.reset} ${c.bold}Scripts${c.reset}     ${c.brightGreen}${totalScripts}${c.reset} ${c.dim}(${extScripts} external, ${inlScripts} inline)${c.reset}`);
console.log(`  ${c.brightCyan}📐${c.reset} ${c.bold}Schema${c.reset}      ${c.brightGreen}${structuredRows.filter((r) => r.schema_present === 'yes').length}${c.reset}${c.dim}/${structuredRows.length} pages with structured data${c.reset}`);
console.log(`  ${c.brightCyan}⏱️${c.reset}  ${c.bold}Time${c.reset}        ${c.brightYellow}${formatDuration(totalElapsed)}${c.reset}`);
console.log(`  ${c.brightCyan}📁${c.reset} ${c.bold}Output${c.reset}      ${c.dim}${outDir}${c.reset}`);

const botBlockedCount = issueRows.filter((r) => r.issue_type === 'bot_protection_blocked').length;
if (botBlockedCount > 0) {
  console.log('');
  statusMsg('⚠', c.brightYellow, `${botBlockedCount} page(s) were blocked by bot protection / a WAF challenge.`);
  statusMsg('💡', c.dim, `Retry with ${c.bold}--slow --cloudflare-aware${c.reset}${c.dim} (add --respect-robots to stay compliant).${c.reset}`);
  statusMsg('💡', c.dim, `If it's still blocked, save the sitemap manually and run with ${c.bold}--urls-file ./urls.txt${c.reset}${c.dim} instead of live discovery.${c.reset}`);
}
console.log('');
console.log(`  ${rainbow('★ ★ ★')} ${c.dim}Happy auditing!${c.reset} ${rainbow('★ ★ ★')}`);
console.log('');
