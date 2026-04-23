export function getIndexabilityStatus(pageSignals = {}) {
  const status = Number(pageSignals.status_code || 0);
  const robotsMeta = String(pageSignals.robots_meta || '').toLowerCase();
  const xRobots = String(pageSignals.x_robots_tag || '').toLowerCase();
  const canonicalStatus = String(pageSignals.canonical_status || '');
  const redirectCount = Number(pageSignals.redirect_count || 0);
  if (status >= 500) return 'error_5xx';
  if (status >= 400) return 'error_4xx';
  if (/noindex/.test(xRobots)) return 'noindex_header';
  if (/noindex/.test(robotsMeta)) return 'noindex_meta';
  if (redirectCount > 0) return 'redirected';
  if (canonicalStatus === 'cross_domain' || canonicalStatus === 'mismatch') return 'canonicalized_elsewhere';
  if (canonicalStatus === 'multiple') return 'conflicting_signals';
  return 'indexable';
}
