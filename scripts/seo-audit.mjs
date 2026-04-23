#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { stringify } from "csv-stringify/sync";
import { runLighthouseAudit } from "./lib/lighthouse-runner.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--crawl") args.crawl = true;
    else if (a.startsWith("--")) {
      const key = a.replace(/^--/, "");
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) args[key] = true;
      else { args[key] = next; i++; }
    }
  }
  return args;
}
const args = parseArgs(process.argv);

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }
function normalizeUrl(u){ try { const url = new URL(u); if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1); url.hash=""; return url.toString(); } catch { return String(u||"").trim(); } }
function normalizeCanonical(u){ return normalizeUrl(u); }
function normalizeWhitespace(s){ return String(s || "").replace(/\s+/g, " ").trim(); }
function decodeUrlForDisplay(u){ try { return decodeURI(String(u||"")); } catch { return String(u||""); } }
function getUrlSection(u){ try { const url=new URL(u); const seg=url.pathname.split("/").filter(Boolean)[0] || "root"; return seg.toLowerCase(); } catch { return "unknown"; } }
function loadUrlsFromFile(filePath){ return fs.readFileSync(filePath, "utf8").split(/\r?\n/g).map((s)=>s.trim()).filter(Boolean).filter((s)=>!s.startsWith("#")).map(normalizeUrl); }
function sleep(ms){ return new Promise((resolve)=>setTimeout(resolve, ms)); }
function formatDuration(ms){ const sec=Math.max(0,ms/1000); if(sec<90) return `${sec.toFixed(1)}s`; const min=sec/60; if(min<90) return `${min.toFixed(1)}m`; const hr=min/60; return `${hr.toFixed(2)}h`; }
function formatElapsed(startedAt){ return formatDuration(Date.now() - startedAt); }
function avg(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function estimateRemaining(done, count, total){ if(count<=0) return "estimating…"; return formatDuration(avg(done) * Math.max(0, total-count)); }
function createHeartbeat(label, intervalMs = 10000, etaLabel = "") {
  const started = Date.now();
  const timer = setInterval(()=>{ process.stdout.write(`   … still working on ${label} | elapsed ${formatElapsed(started)}${etaLabel ? ` | ${etaLabel}` : ""}\n`); }, intervalMs);
  return ()=>clearInterval(timer);
}
function isSameOrigin(u, origin){ try { return new URL(u).origin === origin; } catch { return false; } }
function detectBotChallengeHtml(html = "", status = 0) {
  const s = String(html || "").toLowerCase();
  return {
    detected: [403,429,503].includes(Number(status)) || s.includes("cloudflare") || s.includes("captcha") || s.includes("just a moment"),
    type: s.includes("cloudflare") || s.includes("just a moment") ? "cloudflare" : s.includes("captcha") ? "captcha" : [403,429,503].includes(Number(status)) ? `http_${status}` : "unknown",
    status: Number(status) || 0,
  };
}
async function fetchText(url, timeoutMs = 30000) {
  const ac = new AbortController();
  const t = setTimeout(()=>ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ac.signal, headers: { "user-agent": "Universal-SEO-Audit", "accept": "text/plain, text/html, application/xml, text/xml, */*" } });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e?.message || e) };
  } finally { clearTimeout(t); }
}
async function buildRobotsMatcher(startUrl) {
  try {
    const robotsUrl = new URL("/robots.txt", startUrl).toString();
    const res = await fetchText(robotsUrl, 20000);
    if (!res.ok || !res.text) return { isAllowedUrl: null, crawlDelayMs: 0 };
    const disallows = [];
    let crawlDelayMs = 0;
    for (const line of res.text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      const m = /^disallow:\s*(.+)$/i.exec(trimmed);
      if (m) disallows.push(m[1].trim());
      const cd = /^crawl-delay:\s*(\d+)$/i.exec(trimmed);
      if (cd && !crawlDelayMs) crawlDelayMs = Number(cd[1]) * 1000;
    }
    function isAllowedUrl(url) {
      try {
        const u = new URL(url);
        const pathWithQuery = `${u.pathname}${u.search || ""}`;
        for (const rule of disallows) {
          if (!rule || rule === "/") continue;
          const normalized = rule.replace(/\*$/, "");
          if (pathWithQuery.startsWith(normalized) || pathWithQuery.includes(normalized.replace(/\*/g, ""))) return false;
        }
        return true;
      } catch { return true; }
    }
    return { isAllowedUrl, crawlDelayMs };
  } catch { return { isAllowedUrl: null, crawlDelayMs: 0 }; }
}
function loadAuthConfig(filePath){
  try { return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8")); }
  catch (e) { throw new Error(`Could not read auth config at ${filePath}: ${String(e?.message || e)}`); }
}
function getAuthSettings(args){
  let cfg = {};
  if (args["auth-config"]) cfg = loadAuthConfig(args["auth-config"]);
  const httpUsername = args["http-username"] || process.env.USEO_HTTP_USERNAME || cfg.httpUsername || "";
  const httpPassword = args["http-password"] || process.env.USEO_HTTP_PASSWORD || cfg.httpPassword || "";
  const loginUrl = args["login-url"] || cfg.loginUrl || "";
  const username = args["username"] || process.env.USEO_LOGIN_USERNAME || cfg.username || "";
  const password = args["password"] || process.env.USEO_LOGIN_PASSWORD || cfg.password || "";
  const usernameSelector = args["username-selector"] || cfg.usernameSelector || "input[name='username'], input[type='email']";
  const passwordSelector = args["password-selector"] || cfg.passwordSelector || "input[name='password'], input[type='password']";
  const submitSelector = args["submit-selector"] || cfg.submitSelector || "button[type='submit'], input[type='submit']";
  const readySelector = args["ready-selector"] || cfg.readySelector || "";
  const postLoginWaitMs = Number(args["post-login-wait-ms"] || cfg.postLoginWaitMs || 2000);
  return {
    httpCredentials: httpUsername || httpPassword ? { username: httpUsername, password: httpPassword } : null,
    formAuth: loginUrl && username ? { loginUrl, username, password, usernameSelector, passwordSelector, submitSelector, readySelector, postLoginWaitMs } : null,
  };
}
async function maybePerformFormLogin(page, formAuth, slowMode = false){
  if (!formAuth) return false;
  console.log(`ℹ Attempting form login at ${formAuth.loginUrl}`);
  await page.goto(formAuth.loginUrl, { waitUntil: slowMode ? "domcontentloaded" : "networkidle", timeout: 90000 });
  await page.locator(formAuth.usernameSelector).first().fill(formAuth.username);
  await page.locator(formAuth.passwordSelector).first().fill(formAuth.password || "");
  if (formAuth.submitSelector) {
    await Promise.allSettled([
      page.waitForLoadState(slowMode ? "domcontentloaded" : "networkidle", { timeout: 20000 }),
      page.locator(formAuth.submitSelector).first().click(),
    ]);
  } else {
    await page.keyboard.press("Enter");
    await page.waitForLoadState(slowMode ? "domcontentloaded" : "networkidle", { timeout: 20000 }).catch(()=>{});
  }
  if (formAuth.readySelector) await page.locator(formAuth.readySelector).first().waitFor({ state: "visible", timeout: 20000 });
  else await page.waitForTimeout(formAuth.postLoginWaitMs || 2000);
  console.log("ℹ Form login step completed.");
  return true;
}
function looksLikeFilename(s){
  const v=(s||"").toLowerCase();
  if(!v) return false;
  if(/(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg)$/i.test(v)) return true;
  if(/^(img|dsc|pxl|image)[-_\s]?\d+/.test(v)) return true;
  return /[_-]/.test(v) && !/\s/.test(v) && /[a-z]/.test(v) && v.length >= 8;
}
function classifyIssue(type){
  const map = {
    http_4xx:["critical","P0-Critical","Highest"],
    http_5xx:["critical","P0-Critical","Highest"],
    broken_internal_link:["serious","P1-High","High"],
    broken_external_link:["moderate","P2-Medium","Medium"],
    missing_title:["serious","P1-High","High"],
    duplicate_title:["serious","P1-High","High"],
    title_too_long:["moderate","P2-Medium","Medium"],
    title_too_short:["moderate","P2-Medium","Medium"],
    missing_meta_description:["moderate","P2-Medium","Medium"],
    duplicate_meta_description:["moderate","P2-Medium","Medium"],
    meta_description_too_long:["minor","P3-Low","Low"],
    meta_description_too_short:["minor","P3-Low","Low"],
    canonical_missing:["serious","P1-High","High"],
    canonical_multiple:["serious","P1-High","High"],
    canonical_cross_domain:["serious","P1-High","High"],
    canonical_mismatch:["moderate","P2-Medium","Medium"],
    h1_missing:["serious","P1-High","High"],
    multiple_h1:["moderate","P2-Medium","Medium"],
    noindex_present:["moderate","P2-Medium","Medium"],
    nofollow_present:["minor","P3-Low","Low"],
    redirect_page:["moderate","P2-Medium","Medium"],
    thin_content:["moderate","P2-Medium","Medium"],
    image_alt_missing:["moderate","P2-Medium","Medium"],
    image_alt_filename:["minor","P3-Low","Low"],
    broken_image:["serious","P1-High","High"],
    image_www_mismatch:["moderate","P2-Medium","Medium"],
    image_host_mismatch:["minor","P3-Low","Low"],
    image_http_on_https:["moderate","P2-Medium","Medium"],
    poor_performance:["moderate","P2-Medium","Medium"],
    lcp_slow:["serious","P1-High","High"],
    cls_high:["serious","P1-High","High"],
    tbt_high:["moderate","P2-Medium","Medium"],
    missing_lang:["moderate","P2-Medium","Medium"],
    missing_viewport:["moderate","P2-Medium","Medium"],
    invalid_jsonld:["moderate","P2-Medium","Medium"],
    noindex_header:["moderate","P2-Medium","Medium"],
    hreflang_invalid:["moderate","P2-Medium","Medium"],
    heavy_dom:["minor","P3-Low","Low"],
    high_resource_count:["minor","P3-Low","Low"],
    missing_schema:["moderate","P2-Medium","Medium"],
    schema_missing_type:["minor","P3-Low","Low"],
    og_title_missing:["minor","P3-Low","Low"],
    og_description_missing:["minor","P3-Low","Low"],
    og_image_missing:["moderate","P2-Medium","Medium"],
    og_image_http:["moderate","P2-Medium","Medium"],
    twitter_card_missing:["minor","P3-Low","Low"],
    twitter_image_missing:["minor","P3-Low","Low"],
    og_url_mismatch:["minor","P3-Low","Low"],
    invalid_schema_type:["moderate","P2-Medium","Medium"],
    render_blocking_assets:["minor","P3-Low","Low"],
    slow_dom_interactive:["minor","P3-Low","Low"],
    duplicate_content_cluster:["moderate","P2-Medium","Medium"],
    orphan_candidate:["moderate","P2-Medium","Medium"],
    scan_error:["serious","P1-High","High"],
  };
  return map[type] || ["moderate","P2-Medium","Medium"];
}
function pushIssue(issues, pageUrl, issueType, details, recommendation, extra = {}){
  const [impact, priority, importance] = classifyIssue(issueType);
  issues.push({ page_url: pageUrl, issue_type: issueType, impact, priority, importance, details: normalizeWhitespace(details), recommendation: normalizeWhitespace(recommendation), ...extra });
}
async function gotoWithRetry(page, url, opts = {}) {
  const { slow = false, retries = 1, backoffMs = 3000, timeoutMs = 90000, cfAware = false } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const stopHeartbeat = createHeartbeat(`${decodeUrlForDisplay(url)} (navigation attempt ${attempt + 1}/${retries + 1})`, 10000);
    try {
      const response = await page.goto(url, { waitUntil: slow ? "domcontentloaded" : "networkidle", timeout: timeoutMs });
      await page.waitForTimeout(slow ? 2000 : 800);
      const html = await page.content();
      const bot = cfAware ? detectBotChallengeHtml(html, response?.status?.() || 0) : { detected: false, type: "", status: 0 };
      stopHeartbeat();
      if (bot.detected) {
        lastErr = new Error(`bot_protection:${bot.type}`);
        if (attempt < retries) {
          const delay = backoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
          console.warn(`   ⚠ Bot protection detected (${bot.type}, status ${bot.status}). Backing off ${Math.ceil(delay/1000)}s then retrying...`);
          await sleep(delay);
          continue;
        }
        throw lastErr;
      }
      return { response, bot };
    } catch (e) {
      stopHeartbeat();
      lastErr = e;
      if (attempt < retries) {
        const delay = backoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
        console.warn(`   ⚠ Navigation failed (${String(e?.message || e)}). Backing off ${Math.ceil(delay/1000)}s then retrying...`);
        await sleep(delay);
      }
    }
  }
  throw lastErr || new Error("navigation_failed");
}
async function extractSeoData(page, pageUrl) {
  return await page.evaluate((pageUrlInBrowser) => {
    const canonicals = Array.from(document.querySelectorAll('link[rel="canonical"]')).map((n) => n.href || n.getAttribute("href") || "");
    const robotsMeta = document.querySelector('meta[name="robots" i]')?.getAttribute("content") || "";
    const viewportMeta = document.querySelector('meta[name="viewport" i]')?.getAttribute("content") || "";
    const htmlLang = document.documentElement?.getAttribute("lang") || "";
    const title = document.title || "";
    const desc = document.querySelector('meta[name="description" i]')?.getAttribute("content") || "";
    const ogTitle = document.querySelector('meta[property="og:title" i]')?.getAttribute("content") || "";
    const ogDescription = document.querySelector('meta[property="og:description" i]')?.getAttribute("content") || "";
    const ogImage = document.querySelector('meta[property="og:image" i]')?.getAttribute("content") || "";
    const ogUrl = document.querySelector('meta[property="og:url" i]')?.getAttribute("content") || "";
    const twitterCard = document.querySelector('meta[name="twitter:card" i]')?.getAttribute("content") || "";
    const twitterTitle = document.querySelector('meta[name="twitter:title" i]')?.getAttribute("content") || "";
    const twitterDescription = document.querySelector('meta[name="twitter:description" i]')?.getAttribute("content") || "";
    const twitterImage = document.querySelector('meta[name="twitter:image" i]')?.getAttribute("content") || "";
    const h1s = Array.from(document.querySelectorAll("h1")).map((n) => n.textContent?.trim() || "");
    const headings = Array.from(document.querySelectorAll("h1,h2,h3")).map((n) => ({ tag: n.tagName.toLowerCase(), text: (n.textContent || "").trim() })).slice(0,20);
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const links = Array.from(document.querySelectorAll("a[href]")).map((a) => ({ href: a.href || a.getAttribute("href") || "", text: (a.textContent || "").trim() }));
    const images = Array.from(document.images).map((img) => ({
      src: img.currentSrc || img.getAttribute("src") || "",
      alt: img.getAttribute("alt") || "",
      title: img.getAttribute("title") || "",
    }));
    const hreflangs = Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map((n) => ({
      hreflang: n.getAttribute("hreflang") || "",
      href: n.getAttribute("href") || "",
    }));
    const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((n) => n.textContent || "");
    let jsonLdValidCount = 0;
    let jsonLdInvalidCount = 0;
    const schemaTypes = [];
    for (const raw of jsonLdScripts) {
      try {
        const parsed = JSON.parse(raw);
        jsonLdValidCount++;
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item && typeof item === "object") {
            const t = item["@type"];
            if (Array.isArray(t)) schemaTypes.push(...t.map(String));
            else if (t) schemaTypes.push(String(t));
            if (Array.isArray(item["@graph"])) {
              for (const node of item["@graph"]) {
                const gt = node?.["@type"];
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
    const resourceEntries = performance.getEntriesByType("resource") || [];
    return {
      url: location.href,
      page_url: pageUrlInBrowser,
      title,
      title_length: title.length,
      meta_description: desc,
      meta_description_length: desc.length,
      og_title: ogTitle,
      og_description: ogDescription,
      og_image: ogImage,
      og_url: ogUrl,
      robots_meta: robotsMeta,
      viewport_meta: viewportMeta,
      html_lang: htmlLang,
      robots_indexable: !/noindex/i.test(robotsMeta),
      robots_followable: !/nofollow/i.test(robotsMeta),
      canonical: canonicals[0] || "",
      canonical_count: canonicals.length,
      h1_count: h1s.length,
      h1_text: h1s.join(" | "),
      word_count: bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0,
      body_excerpt: bodyText.slice(0, 4000),
      heading_outline: headings.map((h) => `${h.tag}:${h.text}`).join(" | "),
      links,
      images,
      hreflang_count: hreflangs.length,
      hreflang_values: hreflangs.map((h) => `${h.hreflang}:${h.href}`).join(" | "),
      hreflang_invalid_count: hreflangs.filter((h) => !h.hreflang || !h.href).length,
      jsonld_count: jsonLdScripts.length,
      jsonld_valid_count: jsonLdValidCount,
      jsonld_invalid_count: jsonLdInvalidCount,
      schema_types: Array.from(new Set(schemaTypes.filter(Boolean))).join(" | "),
      dom_node_count: document.querySelectorAll("*").length,
      script_tag_count: document.querySelectorAll("script").length,
      stylesheet_count: document.querySelectorAll('link[rel="stylesheet"]').length,
      resource_count: resourceEntries.length,
    };
  }, pageUrl);
}

async function checkLink(url) {
  const headers = { "user-agent": "Universal-SEO-Audit Link Checker" };
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow", headers });
    if (res.status === 405 || res.status === 501) res = await fetch(url, { method: "GET", redirect: "follow", headers });
    return { status: res.status, ok: res.ok };
  } catch (e) {
    return { status: 0, ok: false, error: String(e?.message || e) };
  }
}

async function checkImage(url, pageUrl) {
  const headers = { "user-agent": "Universal-SEO-Audit Image Checker" };
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow", headers });
    if (res.status === 405 || res.status === 501) res = await fetch(url, { method: "GET", redirect: "follow", headers });
    const finalUrl = res.url || url;
    const originalHost = new URL(url, pageUrl).host;
    const finalHost = new URL(finalUrl, pageUrl).host;
    const pageHost = new URL(pageUrl).host;
    return {
      status: res.status,
      ok: res.ok,
      final_url: finalUrl,
      image_host: originalHost,
      image_final_host: finalHost,
      image_host_mismatch: originalHost !== finalHost ? "yes" : "no",
      image_www_mismatch: originalHost.replace(/^www\./,"") === finalHost.replace(/^www\./,"") && originalHost !== finalHost ? "yes" : "no",
      image_non_canonical_host: originalHost.replace(/^www\./,"") === pageHost.replace(/^www\./,"") && originalHost !== pageHost ? "yes" : "no",
      image_http_on_https: String(url).startsWith("http://") && String(pageUrl).startsWith("https://") ? "yes" : "no"
    };
  } catch (e) {
    const originalHost = (() => { try { return new URL(url, pageUrl).host; } catch { return ""; } })();
    return {
      status: 0,
      ok: false,
      final_url: "",
      image_host: originalHost,
      image_final_host: "",
      image_host_mismatch: "no",
      image_www_mismatch: "no",
      image_non_canonical_host: "no",
      image_http_on_https: String(url).startsWith("http://") && String(pageUrl).startsWith("https://") ? "yes" : "no",
      error: String(e?.message || e)
    };
  }
}

async function main() {
  const baseOutDir = path.resolve(process.cwd(), args["out-dir"] || "reports");
  const runId = args["run-id"] ? String(args["run-id"]) : `site-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;
  const outDir = path.join(baseOutDir, runId);
  ensureDir(outDir);

  const startUrl = args.start ? normalizeUrl(args.start) : "https://example.com/";
  const startOrigin = new URL(startUrl).origin;
  const slowMode = Boolean(args["slow"]);
  const cfAware = Boolean(args["cloudflare-aware"]);
  const retries = args["retries"] ? Number(args["retries"]) : (slowMode ? 2 : 1);
  const backoffMs = args["backoff-ms"] ? Number(args["backoff-ms"]) : (slowMode ? 8000 : 3000);
  const maxPages = args["max-pages"] ? Number(args["max-pages"]) : 50;
  const respectRobots = Boolean(args["respect-robots"]);
  const batchSize = args["batch-size"] ? Number(args["batch-size"]) : 0;
  const maxLinkChecks = args["max-link-checks"] ? Number(args["max-link-checks"]) : 250;
  const auth = getAuthSettings(args);
  const runLighthouse = Boolean(args["lighthouse"]);

  let robotsCfg = { isAllowedUrl: null, crawlDelayMs: 0 };
  if (respectRobots) robotsCfg = await buildRobotsMatcher(startUrl);
  const crawlDelayMs = args["crawl-delay-ms"] ? Number(args["crawl-delay-ms"]) : (robotsCfg.crawlDelayMs || (slowMode ? 1500 : 0));

  if (respectRobots) console.log("ℹ Respecting robots.txt Disallow rules (--respect-robots).");
  if (auth.httpCredentials) console.log("ℹ HTTP/basic auth credentials configured for this run.");
  if (auth.formAuth) console.log("ℹ Form-login auth config detected for this run.");

  let urls = [];
  if (args.crawl) {
    const browser = await chromium.launch({ headless: true });
    const crawlContextOptions = {};
    if (auth.httpCredentials) crawlContextOptions.httpCredentials = auth.httpCredentials;
    const context = await browser.newContext(crawlContextOptions);
    const page = await context.newPage();
    if (auth.formAuth) await maybePerformFormLogin(page, auth.formAuth, slowMode);
    const queue = [normalizeUrl(startUrl)];
    const seen = new Set(queue);
    while (queue.length && seen.size < maxPages) {
      const current = queue.shift();
      try {
        await page.goto(current, { waitUntil: slowMode ? "domcontentloaded" : "networkidle", timeout: 60000 });
        const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")).filter(Boolean));
        for (const href of hrefs) {
          try {
            const abs = normalizeUrl(new URL(href, current).toString());
            if (!isSameOrigin(abs, startOrigin)) continue;
            if (robotsCfg.isAllowedUrl && !robotsCfg.isAllowedUrl(abs)) continue;
            if (!seen.has(abs) && seen.size < maxPages) { seen.add(abs); queue.push(abs); }
          } catch {}
        }
      } catch {}
    }
    urls = Array.from(seen);
    await browser.close();
  } else if (args["urls-file"]) {
    urls = loadUrlsFromFile(path.resolve(process.cwd(), args["urls-file"]));
    if (robotsCfg.isAllowedUrl) urls = urls.filter((u) => robotsCfg.isAllowedUrl(u));
  } else {
    urls = [startUrl];
  }

  if (batchSize > 0 && urls.length > batchSize) urls = urls.slice(0, batchSize);

  if (urls.length >= 100) console.log(`ℹ Large scan detected (${urls.length} pages). This may take a while.`);
  if (urls.length >= 500) console.log("⚠ Very large scan. Consider smaller batches if the site is sensitive or rate-limited.");
  if (batchSize > 0) console.log(`ℹ Small-batch mode enabled (${batchSize} page max for this run).`);
  if (slowMode) {
    console.log("ℹ Running in --slow mode (conservative scan: longer delays + retries).");
    console.log("ℹ Slow/protected-site scans can take significantly longer than normal runs.");
  }
  if (cfAware) {
    console.log("ℹ Cloudflare-aware challenge detection enabled (--cloudflare-aware).");
    console.log("ℹ Challenge pages, retries, and backoff can make scans look quiet for a while. Heartbeat lines will show progress.");
  }
  if (crawlDelayMs > 0) console.log(`ℹ Using crawl delay: ${Math.ceil(crawlDelayMs/1000)}s between pages.`);
  if (retries > 1 || backoffMs >= 5000) console.log(`ℹ Retry policy: ${retries} retries, base backoff ${Math.ceil(backoffMs/1000)}s.`);
  if (auth.httpCredentials || auth.formAuth) console.log("ℹ Authenticated mode enabled for protected/staging/dev sites.");

  const browser = await chromium.launch({ headless: true });
  const contextOptions = { userAgent: "Universal-SEO-Audit (Playwright)" };
  if (auth.httpCredentials) contextOptions.httpCredentials = auth.httpCredentials;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  if (auth.formAuth) await maybePerformFormLogin(page, auth.formAuth, slowMode);

  const pageRows = [];
  const issueRows = [];
  const imageRows = [];
  const structuredRows = [];
  const socialRows = [];
  const crawlRows = [];
  const lighthouseRows = [];
  const startedAt = Date.now();
  const completedDurations = [];
  let pageErrors = 0;
  const titleMap = new Map();
  const descMap = new Map();
  const pageLinksMap = new Map();
  const uniqueLinks = new Map();

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const pageStart = Date.now();
    console.log(`[${i+1}/${urls.length}] Scanning: ${decodeUrlForDisplay(url)} | ETA remaining: ${estimateRemaining(completedDurations, i, urls.length)}`);
    try {
      const nav = await gotoWithRetry(page, url, { slow: slowMode, retries, backoffMs, timeoutMs: 90000, cfAware });
      if (nav.bot?.detected) throw new Error(`bot_protection:${nav.bot.type}`);
      if (crawlDelayMs > 0) await sleep(crawlDelayMs);

      const stop = createHeartbeat(`${decodeUrlForDisplay(url)} (SEO extraction)`, 10000, `ETA remaining: ${estimateRemaining(completedDurations, i, urls.length)}`);
      const data = await extractSeoData(page, url);
      stop();

      const status = nav.response?.status?.() || 0;
      const title = normalizeWhitespace(data.title);
      const desc = normalizeWhitespace(data.meta_description);
      const robotsMeta = normalizeWhitespace(data.robots_meta);
      const canonical = normalizeCanonical(data.canonical);
      const finalUrl = normalizeUrl(data.url || url);

      pageRows.push({
        page_url: url,
        final_url: finalUrl,
        status_code: status,
        title,
        title_length: data.title_length,
        meta_description: desc,
        meta_description_length: data.meta_description_length,
        og_title: normalizeWhitespace(data.og_title),
        og_description: normalizeWhitespace(data.og_description),
        og_image: normalizeWhitespace(data.og_image),
        og_url: normalizeWhitespace(data.og_url),
        robots_meta: robotsMeta,
        x_robots_tag: (nav.response?.headers?.()["x-robots-tag"] || ""),
        indexable: data.robots_indexable ? "yes" : "no",
        followable: data.robots_followable ? "yes" : "no",
        viewport_meta: data.viewport_meta,
        html_lang: data.html_lang,
        canonical,
        canonical_count: data.canonical_count,
        h1_count: data.h1_count,
        h1_text: data.h1_text,
        word_count: data.word_count,
        heading_outline: data.heading_outline,
        internal_link_count: data.links.filter((l)=>{ try { return new URL(l.href, finalUrl).origin === startOrigin; } catch { return false; } }).length,
        external_link_count: data.links.filter((l)=>{ try { return new URL(l.href, finalUrl).origin !== startOrigin; } catch { return false; } }).length,
        image_count: data.images.length,
        hreflang_count: data.hreflang_count,
        jsonld_count: data.jsonld_count,
        jsonld_invalid_count: data.jsonld_invalid_count,
        dom_node_count: data.dom_node_count,
        resource_count: data.resource_count,
      });

      if (title) {
        const key = title.toLowerCase();
        if (!titleMap.has(key)) titleMap.set(key, new Set());
        titleMap.get(key).add(url);
      }
      if (desc) {
        const key = desc.toLowerCase();
        if (!descMap.has(key)) descMap.set(key, new Set());
        descMap.get(key).add(url);
      }

      const linksForPage = [];
      for (const l of data.links) {
        try {
          const abs = normalizeUrl(new URL(l.href, finalUrl).toString());
          if (/^(mailto:|tel:|javascript:)/i.test(abs)) continue;
          const kind = isSameOrigin(abs, startOrigin) ? "internal" : "external";
          linksForPage.push({ href: abs, kind, anchor_text: normalizeWhitespace(l.text) });
          if (!uniqueLinks.has(abs) && uniqueLinks.size < maxLinkChecks) uniqueLinks.set(abs, kind);
        } catch {}
      }
      pageLinksMap.set(url, linksForPage);

      let pageIssues = 0;
      const add = (type, details, recommendation, extra={}) => { pushIssue(issueRows, url, type, details, recommendation, extra); pageIssues++; };

      if (status >= 400 && status < 500) add("http_4xx", `Page returned HTTP ${status}.`, "Fix the broken page, routing, or internal linking so the page resolves successfully.", { status_code: status });
      if (status >= 500) add("http_5xx", `Page returned HTTP ${status}.`, "Fix the server or application error so the page returns a successful response.", { status_code: status });
      if (status >= 300 && status < 400) add("redirect_page", `Page returned redirect status ${status}.`, "Review whether this URL should be included in the crawl scope or replaced by its final destination.", { status_code: status });

      if (!title) add("missing_title", "Missing <title> tag.", "Add a unique, descriptive title tag.");
      else {
        if (title.length > 60) add("title_too_long", `Title length is ${title.length}.`, "Shorten the title so it is easier to display fully in search results.");
        if (title.length < 10) add("title_too_short", `Title length is ${title.length}.`, "Expand the title so it better describes the page.");
      }

      if (!desc) add("missing_meta_description", "Missing meta description.", "Add a unique meta description for the page.");
      else {
        if (desc.length > 160) add("meta_description_too_long", `Meta description length is ${desc.length}.`, "Shorten the meta description so it is more likely to display fully.");
        if (desc.length < 50) add("meta_description_too_short", `Meta description length is ${desc.length}.`, "Expand the meta description so it better summarizes the page.");
      }

      if (!canonical) add("canonical_missing", "Missing canonical tag.", "Add a canonical tag that points to the preferred URL.");
      if (Number(data.canonical_count || 0) > 1) add("canonical_multiple", `Found ${data.canonical_count} canonical tags.`, "Reduce canonical tags to a single authoritative tag.");
      if (canonical) {
        try {
          if (new URL(canonical).origin !== new URL(url).origin) add("canonical_cross_domain", `Canonical points to another domain: ${canonical}`, "Confirm the cross-domain canonical is intentional. If not, point it to the correct first-party canonical URL.");
          else if (canonical !== normalizeUrl(url)) add("canonical_mismatch", `Canonical does not match the crawled URL. Canonical: ${canonical}`, "Review whether this canonical target is intentional and matches the preferred version of the page.");
        } catch {}
      }

      if (!data.robots_indexable) add("noindex_present", `Robots meta contains noindex: ${robotsMeta || "noindex"}.`, "Remove noindex if this page is intended to be indexable.");
      if (!data.robots_followable) add("nofollow_present", `Robots meta contains nofollow: ${robotsMeta || "nofollow"}.`, "Remove nofollow if search engines should follow links from this page.");
      const xRobotsTag = nav.response?.headers?.()["x-robots-tag"] || "";
      if (/noindex/i.test(xRobotsTag)) add("noindex_header", `X-Robots-Tag contains noindex: ${xRobotsTag}`, "Remove the noindex directive from the response header if this page should be indexable.");
      if (!normalizeWhitespace(data.viewport_meta)) add("missing_viewport", "Missing viewport meta tag.", 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> for mobile-friendly rendering.');
      if (!normalizeWhitespace(data.html_lang)) add("missing_lang", "Missing html lang attribute.", "Add a valid lang attribute on the <html> element.");
      if (Number(data.jsonld_invalid_count || 0) > 0) add("invalid_jsonld", `${data.jsonld_invalid_count} JSON-LD block(s) could not be parsed.`, "Fix invalid JSON-LD so structured data can be parsed reliably.");
      if (Number(data.hreflang_invalid_count || 0) > 0) add("hreflang_invalid", `${data.hreflang_invalid_count} hreflang tag(s) are missing hreflang or href values.`, "Fix incomplete hreflang tags so alternate language/region signals are valid.");
      if (Number(data.dom_node_count || 0) > 1500) add("heavy_dom", `DOM node count is ${data.dom_node_count}.`, "Reduce overly complex page markup where practical to improve crawl/render efficiency.");
      if (Number(data.resource_count || 0) > 200) add("high_resource_count", `Resource count is ${data.resource_count}.`, "Reduce unnecessary requests where practical to simplify page rendering.");

      if (Number(data.h1_count || 0) === 0) add("h1_missing", "No H1 found on the page.", "Add a single descriptive H1.");
      if (Number(data.h1_count || 0) > 1) add("multiple_h1", `Found ${data.h1_count} H1 elements.`, "Reduce to a single primary H1 unless multiple H1s are explicitly intentional and semantically valid.");

      if (Number(data.word_count || 0) > 0 && Number(data.word_count || 0) < 150) add("thin_content", `Word count is ${data.word_count}.`, "Expand the page content so the page has enough unique, useful information.");

      const canonicalStatus = !canonical ? "missing" : Number(data.canonical_count || 0) > 1 ? "multiple" : (() => {
        try {
          const current = normalizeUrl(url);
          if (new URL(canonical).origin !== new URL(current).origin) return "cross_domain";
          if (canonical !== current) return "mismatch";
          return "self_referencing";
        } catch { return "review"; }
      })();
      structuredRows.push({
        page_url: url,
        x_robots_tag: xRobotsTag,
        html_lang: normalizeWhitespace(data.html_lang),
        viewport_meta: normalizeWhitespace(data.viewport_meta),
        canonical,
        canonical_status: canonicalStatus,
        hreflang_count: data.hreflang_count,
        hreflang_values: data.hreflang_values,
        jsonld_count: data.jsonld_count,
        jsonld_valid_count: data.jsonld_valid_count,
        jsonld_invalid_count: data.jsonld_invalid_count,
        schema_present: data.jsonld_count > 0 ? "yes" : "no",
        schema_valid: data.jsonld_count > 0 && data.jsonld_invalid_count === 0 ? "yes" : "no",
        schema_types: data.schema_types,
        dom_node_count: data.dom_node_count,
        script_tag_count: data.script_tag_count,
        stylesheet_count: data.stylesheet_count,
        resource_count: data.resource_count,
      });
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

if (runLighthouse) {
  try {
    const lh = await runLighthouseAudit(finalUrl);
    lighthouseRows.push(lh);
    if (Number(lh.performance_score || 0) > 0 && Number(lh.performance_score) < 50) add("poor_performance", `Low Lighthouse performance score: ${lh.performance_score}.`, "Improve Core Web Vitals and reduce render-blocking resources.");
    if (Number(lh.lcp_ms || 0) > 4000) add("lcp_slow", `Largest Contentful Paint is slow: ${lh.lcp_ms}ms.`, "Optimize LCP by reducing server delay, image payloads, and render-blocking dependencies.");
    if (Number(lh.cls || 0) > 0.25) add("cls_high", `Cumulative Layout Shift is high: ${lh.cls}.`, "Reduce layout shifts by reserving space for media/embeds and stabilizing dynamic UI.");
    if (Number(lh.tbt_ms || 0) > 300) add("tbt_high", `Total Blocking Time is high: ${lh.tbt_ms}ms.`, "Reduce long main-thread tasks and defer or split heavy JavaScript.");
  } catch (e) {
    lighthouseRows.push({
      page_url: url,
      final_url: finalUrl,
      lighthouse_available: "no",
      performance_score: "",
      lcp_ms: "",
      cls: "",
      tbt_ms: "",
      fcp_ms: "",
      si_ms: "",
      note: `Lighthouse failed: ${String(e?.message || e)}`
    });
  }
}

      let missingAlt = 0, filenameAlt = 0, brokenImages = 0, wwwMismatchImages = 0, hostMismatchImages = 0, httpOnHttpsImages = 0;
      for (const img of data.images) {
        const alt = normalizeWhitespace(img.alt);
        const src = normalizeWhitespace(img.src);
        const imgCheck = src ? await checkImage(src, finalUrl) : null;
        imageRows.push({
          page_url: url,
          image_url: src,
          alt_text: alt,
          title_text: normalizeWhitespace(img.title),
          alt_present: alt ? "yes" : "no",
          alt_looks_like_filename: looksLikeFilename(alt) ? "yes" : "no",
          image_status_code: imgCheck?.status || "",
          image_final_url: imgCheck?.final_url || "",
          image_host: imgCheck?.image_host || "",
          image_final_host: imgCheck?.image_final_host || "",
          image_broken: imgCheck && !imgCheck.ok ? "yes" : "no",
          image_host_mismatch: imgCheck?.image_host_mismatch || "no",
          image_www_mismatch: imgCheck?.image_www_mismatch || "no",
          image_non_canonical_host: imgCheck?.image_non_canonical_host || "no",
          image_http_on_https: imgCheck?.image_http_on_https || "no",
        });
        if (!alt) missingAlt++;
        else if (looksLikeFilename(alt)) filenameAlt++;
        if (imgCheck && !imgCheck.ok) brokenImages++;
        if (imgCheck?.image_www_mismatch === "yes") wwwMismatchImages++;
        if (imgCheck?.image_host_mismatch === "yes") hostMismatchImages++;
        if (imgCheck?.image_http_on_https === "yes") httpOnHttpsImages++;
      }
      if (missingAlt > 0) add("image_alt_missing", `${missingAlt} image(s) are missing alt text.`, "Add meaningful alt text to informative images and leave decorative images intentionally empty only when appropriate.");
      if (filenameAlt > 0) add("image_alt_filename", `${filenameAlt} image(s) appear to use filename-like alt text.`, "Replace filename-style alt text with human-readable, descriptive alt text.");
      if (brokenImages > 0) add("broken_image", `${brokenImages} image(s) returned an error or failed to load directly.`, "Fix or replace broken image URLs so assets resolve correctly.");
      if (wwwMismatchImages > 0) add("image_www_mismatch", `${wwwMismatchImages} image(s) use a different www/non-www host than their resolved destination.`, "Standardize image URLs so image assets use the canonical host consistently.");
      if (hostMismatchImages > 0) add("image_host_mismatch", `${hostMismatchImages} image(s) changed host between requested and final URL.`, "Review image hosting and redirects to ensure asset URLs resolve to the intended host.");
      if (httpOnHttpsImages > 0) add("image_http_on_https", `${httpOnHttpsImages} image(s) are served over HTTP on an HTTPS page.`, "Serve all images over HTTPS to avoid mixed-content and trust issues.");

      completedDurations.push(Date.now() - pageStart);
      console.log(`   ↳ Done in ${formatElapsed(pageStart)} | issues found: ${pageIssues} | elapsed: ${formatElapsed(startedAt)} | ETA remaining: ${estimateRemaining(completedDurations, i + 1, urls.length)}`);
    } catch (err) {
      pageErrors++;
      pushIssue(issueRows, url, "scan_error", `SEO scan failed: ${String(err?.message || err)}`, "Review whether the page is accessible, protected, or blocked by bot protection before re-running the scan.");
      completedDurations.push(Date.now() - pageStart);
      console.log(`   ↳ ERROR in ${formatElapsed(pageStart)} | elapsed: ${formatElapsed(startedAt)} | ETA remaining: ${estimateRemaining(completedDurations, i + 1, urls.length)}`);
    }
  }

  // Duplicate clustering
  for (const [titleKey, pages] of titleMap.entries()) {
    if (!titleKey || pages.size < 2) continue;
    const list = Array.from(pages).slice(0, 10);
    for (const pageUrl of list) pushIssue(issueRows, pageUrl, "duplicate_title", `Title is duplicated across ${pages.size} pages. Example pages: ${list.join(" | ")}`, "Make title tags unique for each page while keeping them descriptive and aligned to search intent.");
  }
  for (const [descKey, pages] of descMap.entries()) {
    if (!descKey || pages.size < 2) continue;
    const list = Array.from(pages).slice(0, 10);
    for (const pageUrl of list) pushIssue(issueRows, pageUrl, "duplicate_meta_description", `Meta description is duplicated across ${pages.size} pages. Example pages: ${list.join(" | ")}`, "Make meta descriptions unique for each page so search snippets better match the page purpose.");
  }

  // Link validation
  if (uniqueLinks.size > 0) {
    console.log("\n=== Link validation ===");
    console.log(`ℹ Checking up to ${uniqueLinks.size} unique links discovered during the crawl.`);
    const linkStatuses = new Map();
    let checked = 0;
    for (const href of uniqueLinks.keys()) {
      checked++;
      if (checked % 25 === 0 || checked === uniqueLinks.size) console.log(`   ↳ Link checks completed: ${checked}/${uniqueLinks.size}`);
      linkStatuses.set(href, await checkLink(href));
    }
    for (const [pageUrl, links] of pageLinksMap.entries()) {
      for (const link of links.slice(0, 50)) {
        const res = linkStatuses.get(link.href);
        if (!res) continue;
        if (res.status >= 400 || (!res.ok && res.status === 0)) {
          if (link.kind === "internal") pushIssue(issueRows, pageUrl, "broken_internal_link", `Broken internal link: ${link.href} (${res.status || "network error"})`, "Update, remove, or fix the destination of this internal link so it resolves correctly.");
          else pushIssue(issueRows, pageUrl, "broken_external_link", `Broken external link: ${link.href} (${res.status || "network error"})`, "Review or replace this external link if the destination is no longer valid.");
        }
      }
    }
  }


  // Duplicate-content clustering by body similarity (best-effort heuristic)
  const contentCandidates = pageRows
    .map((p) => ({ page_url: p.page_url, word_count: Number(p.word_count || 0), body_excerpt: p.body_excerpt || "" }))
    .filter((p) => p.word_count >= 150 && p.body_excerpt);
  const clusters = [];
  const used = new Set();
  const limit = Math.min(contentCandidates.length, 120);
  for (let i = 0; i < limit; i++) {
    if (used.has(contentCandidates[i].page_url)) continue;
    const a = contentCandidates[i];
    const aSet = tokenSet(a.body_excerpt);
    const cluster = [a.page_url];
    for (let j = i + 1; j < limit; j++) {
      const b = contentCandidates[j];
      if (used.has(b.page_url)) continue;
      const sim = jaccardSimilarity(aSet, tokenSet(b.body_excerpt));
      if (sim >= 0.82) {
        cluster.push(b.page_url);
        used.add(b.page_url);
      }
    }
    if (cluster.length > 1) {
      clusters.push(cluster);
      for (const pageUrl of cluster) {
        pushIssue(issueRows, pageUrl, "duplicate_content_cluster", `Page body content is highly similar to ${cluster.length - 1} other page(s). Cluster sample: ${cluster.slice(0,5).join(" | ")}`, "Review whether these pages should be consolidated, canonicalized, or differentiated with more unique content.");
      }
    }
  }

  // Crawl analysis: link depth + orphan candidates within scanned set
  const scannedSet = new Set(urls);
  const adjacency = new Map();
  const inlinks = new Map();
  for (const url of urls) { adjacency.set(url, []); inlinks.set(url, 0); }
  for (const [pageUrl, links] of pageLinksMap.entries()) {
    for (const link of links) {
      if (link.kind !== "internal") continue;
      const target = normalizeUrl(link.href);
      if (!scannedSet.has(target)) continue;
      adjacency.get(pageUrl).push(target);
      inlinks.set(target, (inlinks.get(target) || 0) + 1);
    }
  }
  const depth = new Map();
  if (urls.length) {
    const bfsQueue = [urls[0]];
    depth.set(urls[0], 0);
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
  for (const url of urls) {
    const urlInlinks = inlinks.get(url) || 0;
    const urlDepth = depth.has(url) ? depth.get(url) : "";
    crawlRows.push({
      page_url: url,
      final_url: pageRows.find((p)=>p.page_url===url)?.final_url || url,
      status_code: pageRows.find((p)=>p.page_url===url)?.status_code || "",
      section: getUrlSection(url),
      inlinks: urlInlinks,
      internal_link_depth: urlDepth,
      orphan_candidate: url !== urls[0] && urlInlinks === 0 ? "yes" : "no",
      crawl_discovered: urlDepth === "" ? "no" : "yes",
      sitemap_only_candidate: url !== urls[0] && urlDepth === "" ? "yes" : "no",
    });
    if (url !== urls[0] && urlInlinks === 0) {
      pushIssue(issueRows, url, "orphan_candidate", "Page has zero internal inlinks within the scanned set and may be an orphan candidate.", "Review whether this page should be linked from the site, removed from the sitemap, or intentionally left isolated.");
    }
  }

  await browser.close();

  const issueCounts = issueRows.reduce((acc, row) => { acc[row.page_url] = (acc[row.page_url] || 0) + 1; return acc; }, {});
  const enrichedPages = pageRows.map((p) => ({ ...p, issue_count: issueCounts[p.page_url] || 0 }));
  const byIssueType = issueRows.reduce((acc, row) => { acc[row.issue_type] = (acc[row.issue_type] || 0) + 1; return acc; }, {});

  fs.writeFileSync(path.join(outDir, "seo-issues.csv"), stringify(issueRows, { header: true, columns: ["page_url","issue_type","impact","priority","importance","status_code","details","recommendation"] }));
  fs.writeFileSync(path.join(outDir, "seo-pages.csv"), stringify(enrichedPages.map(({body_excerpt, ...rest})=>rest), { header: true, columns: ["page_url","final_url","status_code","section","title","title_length","meta_description","meta_description_length","og_title","og_description","og_image","og_url","robots_meta","x_robots_tag","indexable","followable","viewport_meta","html_lang","canonical","canonical_count","h1_count","h1_text","word_count","heading_outline","internal_link_count","external_link_count","image_count","hreflang_count","jsonld_count","jsonld_invalid_count","dom_node_count","resource_count","issue_count"] }));
  fs.writeFileSync(path.join(outDir, "seo-images.csv"), stringify(imageRows, { header: true, columns: ["page_url","image_url","alt_text","title_text","alt_present","alt_looks_like_filename","image_status_code","image_final_url","image_host","image_final_host","image_broken","image_host_mismatch","image_www_mismatch","image_non_canonical_host","image_http_on_https"] }));
  fs.writeFileSync(path.join(outDir, "seo-structured-data.csv"), stringify(structuredRows, { header: true, columns: ["page_url","x_robots_tag","html_lang","viewport_meta","canonical","canonical_status","hreflang_count","hreflang_values","jsonld_count","jsonld_valid_count","jsonld_invalid_count","schema_present","schema_valid","schema_types","dom_node_count","script_tag_count","stylesheet_count","resource_count"] }));
  fs.writeFileSync(path.join(outDir, "seo-social.csv"), stringify(socialRows, { header: true, columns: ["page_url","final_url","title","og_title","og_description","og_image","og_url","twitter_card","twitter_title","twitter_description","twitter_image"] }));
  const sectionSummaryRows = Object.values(enrichedPages.reduce((acc, row) => { const k = row.section || "root"; if (!acc[k]) acc[k] = { section:k, page_count:0, total_issues:0, total_words:0, orphan_candidates:0 }; acc[k].page_count += 1; acc[k].total_issues += Number(row.issue_count || 0); acc[k].total_words += Number(row.word_count || 0); const crawlMatch = crawlRows.find((c)=>c.page_url===row.page_url); if ((crawlMatch?.orphan_candidate || "no") === "yes") acc[k].orphan_candidates += 1; return acc; }, {})).map((r)=>({ ...r, avg_issue_count: r.page_count ? (r.total_issues / r.page_count).toFixed(2) : "0.00", avg_word_count: r.page_count ? Math.round(r.total_words / r.page_count) : 0 }));
  fs.writeFileSync(path.join(outDir, "seo-crawl-analysis.csv"), stringify(crawlRows, { header: true, columns: ["page_url","final_url","status_code","section","inlinks","internal_link_depth","orphan_candidate","crawl_discovered","sitemap_only_candidate"] }));
  fs.writeFileSync(path.join(outDir, "seo-section-summary.csv"), stringify(sectionSummaryRows, { header: true, columns: ["section","page_count","total_issues","avg_issue_count","avg_word_count","orphan_candidates"] }));
  fs.writeFileSync(path.join(outDir, "seo-lighthouse.csv"), stringify((runLighthouse ? lighthouseRows : enrichedPages.map((p)=>({ page_url:p.page_url, final_url:p.final_url, lighthouse_available:"no", performance_score:"", lcp_ms:"", cls:"", tbt_ms:"", fcp_ms:"", si_ms:"", note:"Run with --lighthouse to collect Lighthouse/Core Web Vitals metrics." }))), { header: true, columns: ["page_url","final_url","lighthouse_available","performance_score","lcp_ms","cls","tbt_ms","fcp_ms","si_ms","note"] }));
  fs.writeFileSync(path.join(outDir, "seo-report.json"), JSON.stringify({ runId, scanned: urls, pages: enrichedPages, issues: issueRows, images: imageRows, structured: structuredRows, social: socialRows }, null, 2));
  fs.writeFileSync(path.join(outDir, "seo-run-metadata.json"), JSON.stringify({
    runId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    pagesScanned: urls.length,
    pageErrors,
    issuesFound: issueRows.length,
    imagesScanned: imageRows.length,
    structuredRows: structuredRows.length,
    socialRows: socialRows.length,
    crawlRows: crawlRows.length,
    sectionSummaryRows: sectionSummaryRows.length,
    lighthouseRows: (runLighthouse ? lighthouseRows.length : 0),
    byIssueType,
    topIssueTypes: Object.entries(byIssueType).sort((a,b)=>b[1]-a[1]).slice(0,20).map(([issue_type, count])=>({ issue_type, count })),
  }, null, 2));
  try { fs.writeFileSync(path.join(baseOutDir, "latest"), runId, "utf8"); } catch {}

  console.log(`Scanned ${urls.length} page(s).`);
  console.log(`SEO issues found: ${issueRows.length}`);
  if (pageErrors) console.log(`Pages with scan errors: ${pageErrors}`);
  console.log(`Run folder: ${outDir}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
