export function bucketPriority(score) {
  if (score >= 80) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

export function calculatePriorityScore(page, issues, crawlData = {}) {
  let score = 0;
  score += Math.min((issues?.length || 0) * 2, 20);
  const types = new Set((issues || []).map((i) => i.issue_type));
  if (types.has('http_4xx') || types.has('http_5xx')) score += 40;
  if (types.has('broken_internal_link')) score += 25;
  if (types.has('canonical_mismatch') || types.has('canonical_cross_domain')) score += 20;
  if (types.has('missing_title')) score += 15;
  if (types.has('duplicate_title') || types.has('duplicate_meta_description')) score += 12;
  if (types.has('missing_schema')) score += 10;
  if (types.has('h1_missing')) score += 10;
  if (types.has('thin_content') || types.has('duplicate_content_cluster')) score += 8;
  const depth = Number(crawlData.internal_link_depth ?? 99);
  const inlinks = Number(crawlData.inlinks ?? 0);
  if (depth <= 2) score += 10; else if (depth <= 4) score += 5;
  if (inlinks >= 10) score += 10; else if (inlinks >= 3) score += 5;
  if (crawlData.orphan_candidate === 'yes') score += 15;
  return Math.min(100, Math.round(score));
}
