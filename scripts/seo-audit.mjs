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
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function normalizeUrl(u) { try { const url = new URL(u); if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0,-1); url.hash=""; return url.toString(); } catch { return String(u||"").trim(); } }
function decodeUrlForDisplay(u) { try { return decodeURI(String(u||"")); } catch { return String(u||""); } }
function normalizeWhitespace(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function loadUrlsFromFile(filePath) { return fs.readFileSync(filePath, "utf8").split(/\r?\n/g).map((s)=>s.trim()).filter(Boolean).filter((s)=>!s.startsWith("#")).map(normalizeUrl); }
function sleep(ms) { return new Promise((resolve)=>setTimeout(resolve, ms)); }
function formatDuration(ms) { const sec=Math.max(0,ms/1000); if(sec<90) return `${sec.toFixed(1)}s`; const min=sec/60; if(min<90) return `${min.toFixed(1)}m`; const hr=min/60; return `${hr.toFixed(2)}h`; }
function formatElapsed(startedAt) { return formatDuration(Date.now()-startedAt); }
function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function estimateRemaining(completedDurations, completedCount, totalCount) { if (completedCount <= 0) return "estimating…"; return formatDuration(avg(completedDurations) * Math.max(0, totalCount - completedCount)); }
function createHeartbeat(label, intervalMs = 10000, etaLabel = "") { const started=Date.now(); const timer=setInterval(()=>{ process.stdout.write(`   … still working on ${label} | elapsed ${formatElapsed(started)}${etaLabel ? ` | ${etaLabel}` : ""}\n`); }, intervalMs); return ()=>clearInterval(timer); }
function printStartupAdvisories({ urlCount, slowMode, cfAware, crawlDelayMs, retries, backoffMs, batchSize = 0, hasAuth = false }) {
  if (urlCount >= 100) console.log(`ℹ Large scan detected (${urlCount} pages). This may take a while.`);
  if (urlCount >= 500) console.log("⚠ Very large scan. Consider smaller batches if the site is sensitive or rate-limited.");
  if (batchSize > 0) console.log(`ℹ Small-batch mode enabled (${batchSize} page max for this run).`);
  if (slowMode) { console.log("ℹ Running in --slow mode (conservative scan: longer delays + retries)."); console.log("ℹ Slow/protected-site scans can take significantly longer than normal runs."); }
  if (cfAware) { console.log("ℹ Cloudflare-aware challenge detection enabled (--cloudflare-aware)."); console.log("ℹ Challenge pages, retries, and backoff can make scans look quiet for a while. Heartbeat lines will show progress."); }
  if (crawlDelayMs > 0) console.log(`ℹ Using crawl delay: ${Math.ceil(crawlDelayMs/1000)}s between pages.`);
  if (retries > 1 || backoffMs >= 5000) console.log(`ℹ Retry policy: ${retries} retries, base backoff ${Math.ceil(backoffMs/1000)}s.`);
  if (hasAuth) console.log("ℹ Authenticated mode enabled for protected/staging/dev sites.");
}
function loadAuthConfig(filePath) { return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8")); }
function getAuthSettings(args) {
  let cfg = {};
  if (args["auth-config"]) cfg = loadAuthConfig(args["auth-config"]);
  const httpUsername = args["http-username"] || process.env.USEO_HTTP_USERNAME || cfg.httpUsername || cfg.basicAuthUsername || "";
  const httpPassword = args["http-password"] || process.env.USEO_HTTP_PASSWORD || cfg.httpPassword || cfg.basicAuthPassword || "";
  const loginUrl = args["login-url"] || cfg.loginUrl || "";
  const username = args["username"] || process.env.USEO_LOGIN_USERNAME || cfg.username || "";
  const password = args["password"] || process.env.USEO_LOGIN_PASSWORD || cfg.password || "";
  const usernameSelector = args["username-selector"] || cfg.usernameSelector || "input[name='username'], input[type='email']";
  const passwordSelector = args["password-selector"] || cfg.passwordSelector || "input[name='password'], input[type='password']";
  const submitSelector = args["submit-selector"] || cfg.submitSelector || "button[type='submit'], input[type='submit']";
  const readySelector = args["ready-selector"] || cfg.readySelector || "";
  const postLoginWaitMs = Number(args["post-login-wait-ms"] || cfg.postLoginWaitMs || 2000);
  return { httpCredentials: httpUsername || httpPassword ? { username: httpUsername, password: httpPassword } : null, formAuth: loginUrl && username ? { loginUrl, username, password, usernameSelector, passwordSelector, submitSelector, readySelector, postLoginWaitMs } : null };
}
async function maybePerformFormLogin(page, formAuth, slowMode = false) {
  if (!formAuth) return false;
  console.log(`ℹ Attempting form login at ${formAuth.loginUrl}`);
  await page.goto(formAuth.loginUrl, { waitUntil: slowMode ? "domcontentloaded" : "networkidle", timeout: 90000 });
  await page.locator(formAuth.usernameSelector).first().fill(formAuth.username);
  await page.locator(formAuth.passwordSelector).first().fill(formAuth.password || "");
  if (formAuth.submitSelector) {
    await Promise.allSettled([page.waitForLoadState(slowMode ? "domcontentloaded" : "networkidle", { timeout: 20000 }), page.locator(formAuth.submitSelector).first().click()]);
  } else {
    await page.keyboard.press("Enter");
    await page.waitForLoadState(slowMode ? "domcontentloaded" : "networkidle", { timeout: 20000 }).catch(()=>{});
  }
  if (formAuth.readySelector) await page.locator(formAuth.readySelector).first().waitFor({ state: "visible", timeout: 20000 });
  else await page.waitForTimeout(formAuth.postLoginWaitMs || 2000);
  console.log("ℹ Form login step completed.");
  return true;
}
function classifyIssue(issueType) {
  const map = {
    http_4xx: ["critical", "P0-Critical", "Highest"],
    http_5xx: ["critical", "P0-Critical", "Highest"],
    missing_title: ["serious", "P1-High", "High"],
    duplicate_title: ["serious", "P1-High", "High"],
    title_too_long: ["moderate", "P2-Medium", "Medium"],
    title_too_short: ["moderate", "P2-Medium", "Medium"],
    missing_meta_description: ["moderate", "P2-Medium", "Medium"],
    meta_description_too_long: ["minor", "P3-Low", "Low"],
    meta_description_too_short: ["minor", "P3-Low", "Low"],
    canonical_missing: ["serious", "P1-High", "High"],
    canonical_multiple: ["serious", "P1-High", "High"],
    canonical_cross_domain: ["serious", "P1-High", "High"],
    canonical_mismatch: ["moderate", "P2-Medium", "Medium"],
    h1_missing: ["serious", "P1-High", "High"],
    multiple_h1: ["moderate", "P2-Medium", "Medium"],
    noindex_present: ["moderate", "P2-Medium", "Medium"],
    nofollow_present: ["minor", "P3-Low", "Low"],
    redirect_page: ["moderate", "P2-Medium", "Medium"],
    scan_error: ["serious", "P1-High", "High"]
  };
  return map[issueType] || ["moderate", "P2-Medium", "Medium"];
}
function pushIssue(issues, pageUrl, issueType, details, recommendation, extra = {}) {
  const [impact, priority, importance] = classifyIssue(issueType);
  issues.push({ page_url: pageUrl, issue_type: issueType, impact, priority, importance, details: normalizeWhitespace(details), recommendation: normalizeWhitespace(recommendation), ...extra });
}
function normalizeCanonical(canonical) { try { const u=new URL(canonical); if(u.pathname!=="/"&&u.pathname.endsWith("/")) u.pathname=u.pathname.slice(0,-1); u.hash=""; return u.toString(); } catch { return String(canonical || ""); } }
async function extractSeoData(page, pageUrl) {
  return await page.evaluate((pageUrlInBrowser) => {
    const canonicals = Array.from(document.querySelectorAll('link[rel="canonical"]')).map((n) => n.href || n.getAttribute("href") || "");
    const robotsMeta = document.querySelector('meta[name="robots" i]')?.getAttribute("content") || "";
    const title = document.title || "";
    const desc = document.querySelector('meta[name="description" i]')?.getAttribute("content") || "";
    const h1s = Array.from(document.querySelectorAll("h1")).map((n) => n.textContent?.trim() || "");
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const links = Array.from(document.querySelectorAll("a[href]")).map((a) => ({ href: a.href || a.getAttribute("href") || "", text: (a.textContent || "").trim() }));
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
      internal_link_count: links.filter((l) => { try { return new URL(l.href, location.href).origin === location.origin; } catch { return false; } }).length,
      external_link_count: links.filter((l) => { try { return new URL(l.href, location.href).origin !== location.origin; } catch { return false; } }).length
    };
  }, pageUrl);
}
async function gotoWithRetry(page, url, opts = {}) {
  const { slow = false, retries = 1, backoffMs = 3000, timeoutMs = 90000 } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const stopHeartbeat = createHeartbeat(`${decodeUrlForDisplay(url)} (navigation attempt ${attempt+1}/${retries+1})`, 10000);
    try {
      const response = await page.goto(url, { waitUntil: slow ? "domcontentloaded" : "networkidle", timeout: timeoutMs });
      await page.waitForTimeout(slow ? 2000 : 800);
      stopHeartbeat();
      return { response };
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
async function main() {
  const args = parseArgs(process.argv);
  const baseOutDir = path.resolve(process.cwd(), args["out-dir"] || "reports");
  const runId = args["run-id"] ? String(args["run-id"]) : `site-${new Date().toISOString().replace(/[-:T]/g, "").slice(0,15)}`;
  const outDir = path.join(baseOutDir, runId);
  ensureDir(outDir);
  const startUrl = args.start ? normalizeUrl(args.start) : "https://example.com/";
  const slowMode = Boolean(args["slow"]);
  const cfAware = Boolean(args["cloudflare-aware"]);
  const retries = args["retries"] ? Number(args["retries"]) : (slowMode ? 2 : 1);
  const backoffMs = args["backoff-ms"] ? Number(args["backoff-ms"]) : (slowMode ? 8000 : 3000);
  const batchSize = args["batch-size"] ? Number(args["batch-size"]) : 0;
  const crawlDelayMs = args["crawl-delay-ms"] ? Number(args["crawl-delay-ms"]) : (slowMode ? 1500 : 0);
  const auth = getAuthSettings(args);
  let urls = args["urls-file"] ? loadUrlsFromFile(path.resolve(process.cwd(), args["urls-file"])) : [startUrl];
  if (batchSize > 0 && urls.length > batchSize) urls = urls.slice(0, batchSize);
  printStartupAdvisories({ urlCount: urls.length, slowMode, cfAware, crawlDelayMs, retries, backoffMs, batchSize, hasAuth: Boolean(auth.httpCredentials || auth.formAuth) });
  const browser = await chromium.launch({ headless: true });
  const contextOptions = { userAgent: "Universal-SEO-Audit (Playwright)" };
  if (auth.httpCredentials) contextOptions.httpCredentials = auth.httpCredentials;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  if (auth.formAuth) await maybePerformFormLogin(page, auth.formAuth, slowMode);
  const pageRows = [], issueRows = [];
  const titleToPages = new Map();
  const startedAt = Date.now();
  const completedDurations = [];
  let pageErrors = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const pageStart = Date.now();
    console.log(`[${i+1}/${urls.length}] Scanning: ${decodeUrlForDisplay(url)} | ETA remaining: ${estimateRemaining(completedDurations, i, urls.length)}`);
    try {
      const nav = await gotoWithRetry(page, url, { slow: slowMode, retries, backoffMs, timeoutMs: 90000 });
      if (crawlDelayMs > 0) await sleep(crawlDelayMs);
      const stopSeoHeartbeat = createHeartbeat(`${decodeUrlForDisplay(url)} (SEO extraction)`, 10000, `ETA remaining: ${estimateRemaining(completedDurations, i, urls.length)}`);
      const data = await extractSeoData(page, url);
      stopSeoHeartbeat();
      const status = nav.response?.status?.() || 0;
      const title = normalizeWhitespace(data.title);
      const desc = normalizeWhitespace(data.meta_description);
      const robotsMeta = normalizeWhitespace(data.robots_meta);
      const current = normalizeUrl(url);
      const canonical = normalizeCanonical(data.canonical);
      pageRows.push({ page_url: url, final_url: data.url || url, status_code: status, title, title_length: data.title_length, meta_description: desc, meta_description_length: data.meta_description_length, robots_meta: robotsMeta, indexable: data.robots_indexable ? "yes" : "no", followable: data.robots_followable ? "yes" : "no", canonical, canonical_count: data.canonical_count, h1_count: data.h1_count, h1_text: data.h1_text, word_count: data.word_count, internal_link_count: data.internal_link_count, external_link_count: data.external_link_count });
      if (title) {
        const arr = titleToPages.get(title) || [];
        arr.push(url);
        titleToPages.set(title, arr);
      }
      if (status >= 400 && status < 500) pushIssue(issueRows, url, "http_4xx", `Page returned HTTP ${status}.`, "Fix the broken page, routing, or internal linking so the page resolves successfully.", { status_code: status });
      if (status >= 500) pushIssue(issueRows, url, "http_5xx", `Page returned HTTP ${status}.`, "Fix the server or application error so the page returns a successful response.", { status_code: status });
      if (!title) pushIssue(issueRows, url, "missing_title", "Missing <title> tag.", "Add a unique, descriptive title tag.");
      else { if (title.length > 60) pushIssue(issueRows, url, "title_too_long", `Title length is ${title.length}.`, "Shorten the title so it is easier to display fully in search results."); if (title.length < 10) pushIssue(issueRows, url, "title_too_short", `Title length is ${title.length}.`, "Expand the title so it better describes the page."); }
      if (!desc) pushIssue(issueRows, url, "missing_meta_description", "Missing meta description.", "Add a unique meta description for the page.");
      else { if (desc.length > 160) pushIssue(issueRows, url, "meta_description_too_long", `Meta description length is ${desc.length}.`, "Shorten the meta description so it is more likely to display fully."); if (desc.length < 50) pushIssue(issueRows, url, "meta_description_too_short", `Meta description length is ${desc.length}.`, "Expand the meta description so it better summarizes the page."); }
      if (!canonical) pushIssue(issueRows, url, "canonical_missing", "Missing canonical tag.", "Add a canonical tag that points to the preferred URL.");
      if (Number(data.canonical_count || 0) > 1) pushIssue(issueRows, url, "canonical_multiple", `Found ${data.canonical_count} canonical tags.`, "Reduce canonical tags to a single authoritative tag.");
      if (canonical) {
        try {
          if (new URL(canonical).origin !== new URL(current).origin) pushIssue(issueRows, url, "canonical_cross_domain", `Canonical points to another domain: ${canonical}`, "Confirm the cross-domain canonical is intentional. If not, point it to the correct first-party canonical URL.");
          else if (canonical !== current) pushIssue(issueRows, url, "canonical_mismatch", `Canonical does not match the crawled URL. Canonical: ${canonical}`, "Review whether this canonical target is intentional and matches the preferred version of the page.");
        } catch {}
      }
      if (!data.robots_indexable) pushIssue(issueRows, url, "noindex_present", `Robots meta contains noindex: ${robotsMeta || "noindex"}.`, "Remove noindex if this page is intended to be indexable.");
      if (!data.robots_followable) pushIssue(issueRows, url, "nofollow_present", `Robots meta contains nofollow: ${robotsMeta || "nofollow"}.`, "Remove nofollow if search engines should follow links from this page.");
      if (Number(data.h1_count || 0) === 0) pushIssue(issueRows, url, "h1_missing", "No H1 found on the page.", "Add a single descriptive H1.");
      if (Number(data.h1_count || 0) > 1) pushIssue(issueRows, url, "multiple_h1", `Found ${data.h1_count} H1 elements.`, "Reduce to a single primary H1 unless multiple H1s are explicitly intentional and semantically valid.");
      completedDurations.push(Date.now() - pageStart);
      console.log(`   ↳ Done in ${formatElapsed(pageStart)} | issues found: ${issueRows.filter((r)=>r.page_url===url).length} | elapsed: ${formatElapsed(startedAt)} | ETA remaining: ${estimateRemaining(completedDurations, i + 1, urls.length)}`);
    } catch (err) {
      pageErrors++;
      completedDurations.push(Date.now() - pageStart);
      pushIssue(issueRows, url, "scan_error", `SEO scan failed: ${String(err?.message || err)}`, "Review whether the page is accessible, protected, or blocked before re-running the scan.");
      console.log(`   ↳ ERROR in ${formatElapsed(pageStart)} | elapsed: ${formatElapsed(startedAt)} | ETA remaining: ${estimateRemaining(completedDurations, i + 1, urls.length)}`);
    }
  }
  for (const [title, pages] of titleToPages.entries()) {
    if (title && pages.length > 1) {
      for (const pageUrl of pages) pushIssue(issueRows, pageUrl, "duplicate_title", `Title is duplicated across ${pages.length} pages: ${title}`, "Make the title unique to better describe this page and reduce duplication.");
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(outDir, "seo-issues.csv"), stringify(issueRows, { header: true, columns: ["page_url","issue_type","impact","priority","importance","status_code","details","recommendation"] }));
  fs.writeFileSync(path.join(outDir, "seo-pages.csv"), stringify(pageRows, { header: true, columns: ["page_url","final_url","status_code","title","title_length","meta_description","meta_description_length","robots_meta","indexable","followable","canonical","canonical_count","h1_count","h1_text","word_count","internal_link_count","external_link_count"] }));
  fs.writeFileSync(path.join(outDir, "seo-report.json"), JSON.stringify({ runId, pages: pageRows, issues: issueRows }, null, 2));
  fs.writeFileSync(path.join(baseOutDir, "latest"), runId, "utf8");
  console.log(`Scanned ${urls.length} page(s).`);
  console.log(`SEO issues found: ${issueRows.length}`);
  if (pageErrors) console.log(`Pages with scan errors: ${pageErrors}`);
  console.log(`Run folder: ${outDir}`);
}
main().catch((e)=>{ console.error(e); process.exit(1); });
