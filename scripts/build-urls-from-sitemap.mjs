#!/usr/bin/env node
import fs from "node:fs";

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
function splitCsvish(v) { return String(v || "").split(",").map((s)=>s.trim()).filter(Boolean); }
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    url.hash = "";
    return url.toString();
  } catch { return String(u || "").trim(); }
}
function selectContentSitemaps(urls, includeSitemaps = [], includeAllSitemaps = false) {
  if (includeAllSitemaps) return urls;
  if (includeSitemaps.length) return urls.filter((u) => includeSitemaps.some((x) => u.includes(x)));
  return urls.filter((u) => /(post|page|wp-sitemap-posts|portfolio|leadership|webinar|podcast|news|testimonial)/i.test(u));
}
async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Universal-SEO-Audit" } });
  if (!res.ok) throw new Error(`Failed ${res.status}: ${url}`);
  return await res.text();
}
function parseSitemapIndex(xml) { return [...xml.matchAll(/<loc>(.*?)<\/loc>/gsi)].map((m) => m[1].trim()); }
function parseUrlSet(xml) { return [...xml.matchAll(/<loc>(.*?)<\/loc>/gsi)].map((m) => normalizeUrl(m[1].trim())); }
async function main() {
  const args = parseArgs(process.argv);
  const site = args.site;
  const out = args.out || "./urls.txt";
  const includeSitemaps = splitCsvish(args["include-sitemaps"]);
  const includeAllSitemaps = Boolean(args["include-all-sitemaps"]);
  if (!site) throw new Error("Missing --site");
  const base = new URL(site).origin;
  const candidates = [args["sitemap-url"], `${base}/sitemap_index.xml`, `${base}/wp-sitemap.xml`, `${base}/sitemap.xml`].filter(Boolean);
  let sitemapUrl = null;
  let xml = null;
  for (const c of candidates) {
    try { xml = await fetchText(c); sitemapUrl = c; break; } catch {}
  }
  if (!xml || !sitemapUrl) throw new Error("Could not fetch sitemap (robots.txt, sitemap_index.xml, sitemap.xml).");
  console.log(`Using sitemap: ${sitemapUrl}`);
  let urls = [];
  if (/<sitemapindex/i.test(xml)) {
    const sitemapUrls = parseSitemapIndex(xml);
    const selected = selectContentSitemaps(sitemapUrls, includeSitemaps, includeAllSitemaps);
    console.log(`Found ${sitemapUrls.length} sitemaps in index; selected ${selected.length}`);
    for (const su of selected) {
      console.log(`Processing ${su}`);
      try { urls.push(...parseUrlSet(await fetchText(su))); } catch {}
    }
  } else {
    urls = parseUrlSet(xml);
  }
  urls = [...new Set(urls)];
  fs.writeFileSync(out, urls.join("\n") + "\n", "utf8");
  console.log(`✔ Wrote ${urls.length} URLs to ${out}`);
}
main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
