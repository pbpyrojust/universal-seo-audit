
import lighthouse from 'lighthouse';
import chromeLauncher from 'chrome-launcher';

export async function runLighthouseAudit(url) {
  const chrome = await chromeLauncher.launch({chromeFlags: ['--headless', '--no-sandbox']});
  const result = await lighthouse(url, {port: chrome.port, output: 'json', logLevel: 'error'});
  const lhr = result.lhr;
  await chrome.kill();

  return {
    url,
    performance: lhr.categories.performance.score * 100,
    lcp: lhr.audits['largest-contentful-paint']?.numericValue,
    cls: lhr.audits['cumulative-layout-shift']?.numericValue,
    tbt: lhr.audits['total-blocking-time']?.numericValue
  };
}
