
import lighthouse from "lighthouse";
import { launch } from "chrome-launcher";

export async function runLighthouseAudit(url) {
  const chrome = await launch({ chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"] });
  try {
    const runnerResult = await lighthouse(url, {
      port: chrome.port,
      output: "json",
      logLevel: "error",
      onlyCategories: ["performance"],
      disableStorageReset: true,
      screenEmulation: { mobile: true }
    });
    const lhr = runnerResult?.lhr || {};
    return {
      page_url: url,
      final_url: lhr.finalDisplayedUrl || lhr.finalUrl || url,
      lighthouse_available: "yes",
      performance_score: Math.round((lhr.categories?.performance?.score || 0) * 100),
      lcp_ms: lhr.audits?.["largest-contentful-paint"]?.numericValue || "",
      cls: lhr.audits?.["cumulative-layout-shift"]?.numericValue || "",
      tbt_ms: lhr.audits?.["total-blocking-time"]?.numericValue || "",
      fcp_ms: lhr.audits?.["first-contentful-paint"]?.numericValue || "",
      si_ms: lhr.audits?.["speed-index"]?.numericValue || "",
      note: ""
    };
  } finally {
    await chrome.kill();
  }
}
