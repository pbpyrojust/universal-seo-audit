#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { stringify } from "csv-stringify/sync";

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
    const title = document.title || "";
    const desc = document.querySelector('meta[name="description" i]')?.getAttribute("content") || "";
    const h1s = Array.from(document.querySelectorAll("h1")).map((n) => n.textContent?.trim() || "");
    const headings = Array.from(document.querySelectorAll("h1,h2,h3")).map((n) => ({ tag: n.tagName.toLowerCase(), text: (n.textContent || "").trim() })).slice(0,20);
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const links = Array.from(document.querySelectorAll("a[href]")).map((a) => ({ href: a.href || a.getAttribute("href") || "", text: (a.textContent || "").trim() }));
    const images = Array.from(document.images).map((img) => ({
      src: img.currentSrc || img.getAttribute("src") || "",
      alt: img.getAttribute("alt") || "",
      title: img.getAttribute("title") || "",
    }));
    return {
      url: location.href,
      page_url: pageUrlInBrowser,
      title,
      title_length: title.length,
      meta_description: desc,
      meta_description_length: desc.length,
      robots_meta: robotsMeta,
      robots_indexable: !/noindex/i.test(robotsMeta),
      robots_followable: !/nofollow/i.test(robotsMeta),
      canonical: canonicals[0] || "",
      canonical_count: canonicals.length,
      h1_count: h1s.length,
      h1_text: h1s.join(" | "),
      word_count: bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0,
      heading_outline: headings.map((h) => `${h.tag}:${h.text}`).join(" | "),
      links,
      images,
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
        robots_meta: robotsMeta,
        indexable: data.robots_indexable ? "yes" : "no",
        followable: data.robots_followable ? "yes" : "no",
        canonical,
        canonical_count: data.canonical_count,
        h1_count: data.h1_count,
        h1_text: data.h1_text,
        word_count: data.word_count,
        heading_outline: data.heading_outline,
        internal_link_count: data.links.filter((l)=>{ try { return new URL(l.href, finalUrl).origin === startOrigin; } catch { return false; } }).length,
        external_link_count: data.links.filter((l)=>{ try { return new URL(l.href, finalUrl).origin !== startOrigin; } catch { return false; } }).length,
        image_count: data.images.length,
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

      if (Number(data.h1_count || 0) === 0) add("h1_missing", "No H1 found on the page.", "Add a single descriptive H1.");
      if (Number(data.h1_count || 0) > 1) add("multiple_h1", `Found ${data.h1_count} H1 elements.`, "Reduce to a single primary H1 unless multiple H1s are explicitly intentional and semantically valid.");

      if (Number(data.word_count || 0) > 0 && Number(data.word_count || 0) < 150) add("thin_content", `Word count is ${data.word_count}.`, "Expand the page content so the page has enough unique, useful information.");

      let missingAlt = 0, filenameAlt = 0;
      for (const img of data.images) {
        const alt = normalizeWhitespace(img.alt);
        imageRows.push({
          page_url: url,
          image_url: normalizeWhitespace(img.src),
          alt_text: alt,
          title_text: normalizeWhitespace(img.title),
          alt_present: alt ? "yes" : "no",
          alt_looks_like_filename: looksLikeFilename(alt) ? "yes" : "no",
        });
        if (!alt) missingAlt++;
        else if (looksLikeFilename(alt)) filenameAlt++;
      }
      if (missingAlt > 0) add("image_alt_missing", `${missingAlt} image(s) are missing alt text.`, "Add meaningful alt text to informative images and leave decorative images intentionally empty only when appropriate.");
      if (filenameAlt > 0) add("image_alt_filename", `${filenameAlt} image(s) appear to use filename-like alt text.`, "Replace filename-style alt text with human-readable, descriptive alt text.");

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

  await browser.close();

  const issueCounts = issueRows.reduce((acc, row) => { acc[row.page_url] = (acc[row.page_url] || 0) + 1; return acc; }, {});
  const enrichedPages = pageRows.map((p) => ({ ...p, issue_count: issueCounts[p.page_url] || 0 }));
  const byIssueType = issueRows.reduce((acc, row) => { acc[row.issue_type] = (acc[row.issue_type] || 0) + 1; return acc; }, {});

  fs.writeFileSync(path.join(outDir, "seo-issues.csv"), stringify(issueRows, { header: true, columns: ["page_url","issue_type","impact","priority","importance","status_code","details","recommendation"] }));
  fs.writeFileSync(path.join(outDir, "seo-pages.csv"), stringify(enrichedPages, { header: true, columns: ["page_url","final_url","status_code","title","title_length","meta_description","meta_description_length","robots_meta","indexable","followable","canonical","canonical_count","h1_count","h1_text","word_count","heading_outline","internal_link_count","external_link_count","image_count","issue_count"] }));
  fs.writeFileSync(path.join(outDir, "seo-images.csv"), stringify(imageRows, { header: true, columns: ["page_url","image_url","alt_text","title_text","alt_present","alt_looks_like_filename"] }));
  fs.writeFileSync(path.join(outDir, "seo-report.json"), JSON.stringify({ runId, scanned: urls, pages: enrichedPages, issues: issueRows, images: imageRows }, null, 2));
  fs.writeFileSync(path.join(outDir, "seo-run-metadata.json"), JSON.stringify({
    runId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    pagesScanned: urls.length,
    pageErrors,
    issuesFound: issueRows.length,
    imagesScanned: imageRows.length,
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
