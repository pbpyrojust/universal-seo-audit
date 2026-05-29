
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

export async function runLighthouseAudit(url) {
  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--no-sandbox'] });
  const result = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error' });
  const lhr = result.lhr;
  await chrome.kill();

  const performanceScore = lhr.categories.performance.score * 100;
  const lcp = lhr.audits['largest-contentful-paint']?.numericValue;
  const cls = lhr.audits['cumulative-layout-shift']?.numericValue;
  const tbt = lhr.audits['total-blocking-time']?.numericValue;
  const fcp = lhr.audits['first-contentful-paint']?.numericValue;
  const si = lhr.audits['speed-index']?.numericValue;

  return {
    url,
    page_url: url,
    final_url: lhr.finalDisplayedUrl || lhr.finalUrl || url,
    lighthouse_available: 'yes',
    performance: performanceScore,
    performance_score: performanceScore,
    lcp,
    lcp_ms: lcp,
    cls,
    tbt,
    tbt_ms: tbt,
    fcp,
    fcp_ms: fcp,
    si,
    si_ms: si,
    note: ''
  };
}
