function tokenize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean).filter((t) => t.length > 2);
}
export function normalizeBodyText(text) {
  return tokenize(text).join(' ');
}
export function computeSimilarity(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}
export function buildDuplicateClusters(pages, threshold = 0.85) {
  const clusters = [];
  const assigned = new Set();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (assigned.has(p.page_url)) continue;
    const members = [{ page_url: p.page_url, similarity_score: 1 }];
    for (let j = i + 1; j < pages.length; j++) {
      const q = pages[j];
      if (assigned.has(q.page_url)) continue;
      const sim = computeSimilarity(p.body_text_normalized, q.body_text_normalized);
      if (sim >= threshold) {
        members.push({ page_url: q.page_url, similarity_score: Number(sim.toFixed(3)) });
        assigned.add(q.page_url);
      }
    }
    if (members.length > 1) {
      const cluster_id = `dup-${clusters.length + 1}`;
      clusters.push({ cluster_id, members });
      assigned.add(p.page_url);
    }
  }
  return clusters;
}
