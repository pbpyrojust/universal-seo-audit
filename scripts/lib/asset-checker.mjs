const MIXUP_RE = /(staging|stage|dev|test|qa|localhost|vercel\.app|netlify\.app)/i;

export function classifyAssetType(url, tagName = '', rel = '') {
  const lower = String(url || '').toLowerCase();
  const relLower = String(rel || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|avif|ico)(\?|#|$)/.test(lower) || tagName === 'img' || tagName === 'source') return 'image';
  if (/\.(css)(\?|#|$)/.test(lower) || relLower.includes('stylesheet')) return 'css';
  if (/\.(js|mjs)(\?|#|$)/.test(lower) || tagName === 'script') return 'js';
  if (/\.(woff2?|ttf|otf|eot)(\?|#|$)/.test(lower)) return 'font';
  return 'other';
}

export async function checkAsset(url, pageHost = '') {
  let original;
  try {
    original = new URL(url);
  } catch {
    return {
      status: 0, ok: false, final_url: '', original_host: '', final_host: '',
      host_mismatch: 'no', www_mismatch: 'no', non_canonical_host: 'no',
      staging_production_mixup: 'no', protocol_mismatch: 'no', content_type: '', error: 'invalid_url'
    };
  }
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': 'Universal-SEO-Audit Asset Checker' } });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'user-agent': 'Universal-SEO-Audit Asset Checker' } });
    }
    const finalUrl = res.url || url;
    const final = new URL(finalUrl);
    const wwwMismatch = original.hostname.replace(/^www\./, '') === final.hostname.replace(/^www\./, '') && original.hostname !== final.hostname;
    const hostMismatch = original.host !== final.host;
    const stagingProductionMixup = MIXUP_RE.test(original.host) || MIXUP_RE.test(final.host) || (pageHost && (MIXUP_RE.test(pageHost) !== MIXUP_RE.test(final.host)));
    return {
      status: res.status,
      ok: res.ok,
      final_url: finalUrl,
      original_host: original.host,
      final_host: final.host,
      host_mismatch: hostMismatch ? 'yes' : 'no',
      www_mismatch: wwwMismatch ? 'yes' : 'no',
      non_canonical_host: pageHost && final.host !== pageHost ? 'yes' : 'no',
      staging_production_mixup: stagingProductionMixup ? 'yes' : 'no',
      protocol_mismatch: original.protocol !== final.protocol ? 'yes' : 'no',
      content_type: res.headers.get('content-type') || ''
    };
  } catch (e) {
    return {
      status: 0,
      ok: false,
      final_url: '',
      original_host: original.host,
      final_host: '',
      host_mismatch: 'no',
      www_mismatch: 'no',
      non_canonical_host: 'no',
      staging_production_mixup: pageHost && (MIXUP_RE.test(original.host) !== MIXUP_RE.test(pageHost)) ? 'yes' : 'no',
      protocol_mismatch: 'no',
      content_type: '',
      error: String(e)
    };
  }
}
