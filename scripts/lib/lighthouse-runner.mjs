
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

let sharedChrome = null;

export async function launchLighthouseChrome() {
  if (sharedChrome) return sharedChrome;
  sharedChrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--no-sandbox'] });
  return sharedChrome;
}

export async function closeLighthouseChrome() {
  if (sharedChrome) {
    await sharedChrome.kill();
    sharedChrome = null;
  }
}

export async function runLighthouseAudit(url, opts = {}) {
  const port = opts.port || sharedChrome?.port;
  const ownChrome = !port;
  let chrome = null;

  if (ownChrome) {
    chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--no-sandbox'] });
  }

  let result;
  try {
    result = await lighthouse(url, {
      port: ownChrome ? chrome.port : port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance'],
    });
  } finally {
    if (ownChrome && chrome) await chrome.kill();
  }

  const lhr = result.lhr;
  const performanceScore = lhr.categories.performance.score * 100;
  const lcp = lhr.audits['largest-contentful-paint']?.numericValue;
  const cls = lhr.audits['cumulative-layout-shift']?.numericValue;
  const tbt = lhr.audits['total-blocking-time']?.numericValue;
  const fcp = lhr.audits['first-contentful-paint']?.numericValue;
  const si = lhr.audits['speed-index']?.numericValue;
  const finalUrl = lhr.finalDisplayedUrl || lhr.finalUrl || url;

  result = null;

  return {
    url,
    page_url: url,
    final_url: finalUrl,
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
