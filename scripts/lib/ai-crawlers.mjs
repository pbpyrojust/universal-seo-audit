/**
 * AI crawler access: which AI bots robots.txt lets fetch a page.
 *
 * Two kinds of bot, treated differently:
 *  - search / user-retrieval bots fetch pages to answer people's questions
 *    in AI assistants and AI search. Blocking them keeps a site out of those
 *    answers, so it's flagged and lowers the agentic score.
 *  - training bots collect pages for model training. Blocking them is a
 *    legitimate choice and is only reported, never penalized.
 *
 * Matching follows RFC 9309 (robots.txt): the group for the most specific
 * matching user-agent applies (falling back to "*"); within it, the longest
 * matching Allow/Disallow path wins, Allow on a tie; "*" and "$" wildcards.
 */
const robotsCache = new Map();

export const AI_BOTS = [
  { agent: 'OAI-SearchBot', owner: 'OpenAI (ChatGPT search)', kind: 'search' },
  { agent: 'ChatGPT-User', owner: 'OpenAI (ChatGPT browsing for a user)', kind: 'search' },
  { agent: 'Claude-SearchBot', owner: 'Anthropic (Claude search)', kind: 'search' },
  { agent: 'Claude-User', owner: 'Anthropic (Claude fetching for a user)', kind: 'search' },
  { agent: 'PerplexityBot', owner: 'Perplexity (search index)', kind: 'search' },
  { agent: 'Perplexity-User', owner: 'Perplexity (fetching for a user)', kind: 'search' },
  { agent: 'Applebot', owner: 'Apple (Siri and Spotlight search)', kind: 'search' },
  { agent: 'GPTBot', owner: 'OpenAI (training)', kind: 'training' },
  { agent: 'ClaudeBot', owner: 'Anthropic (training)', kind: 'training' },
  { agent: 'Google-Extended', owner: 'Google (Gemini training and grounding)', kind: 'training' },
  { agent: 'Applebot-Extended', owner: 'Apple (AI training)', kind: 'training' },
  { agent: 'CCBot', owner: 'Common Crawl (used by many AI models)', kind: 'training' },
  { agent: 'Meta-ExternalAgent', owner: 'Meta (AI training)', kind: 'training' },
  { agent: 'Bytespider', owner: 'ByteDance (AI training)', kind: 'training' },
  { agent: 'Amazonbot', owner: 'Amazon (Alexa and AI)', kind: 'training' },
];

/** Parses robots.txt into groups: [{ agents: [lowercase], rules: [{ allow, path }] }]. */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      if (key === 'disallow' && value === '') continue; // "Disallow:" with no path allows everything.
      current.rules.push({ allow: key === 'allow', path: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegex(path) {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

/** Whether `agent` may fetch `path` under the parsed robots groups. */
export function isAllowed(groups, agent, path) {
  const ua = agent.toLowerCase();
  // Most specific group: an agent token that the bot's name starts with (longest wins), else "*".
  let best = null;
  let bestLen = -1;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a !== '*' && ua.startsWith(a) && a.length > bestLen) {
        best = g;
        bestLen = a.length;
      }
    }
  }
  if (!best) best = groups.find((g) => g.agents.includes('*')) || null;
  if (!best) return true;
  let verdict = true;
  let matchLen = -1;
  for (const rule of best.rules) {
    if (patternToRegex(rule.path).test(path)) {
      const len = rule.path.length;
      if (len > matchLen || (len === matchLen && rule.allow)) {
        verdict = rule.allow;
        matchLen = len;
      }
    }
  }
  return verdict;
}

async function fetchRobots(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let result;
  try {
    const res = await fetch(`${origin}/robots.txt`, { redirect: 'follow', headers: { 'user-agent': 'Universal-SEO-Audit AI Crawler Check' } });
    // 4xx means "no rules" (everything allowed); 5xx is treated the same here but noted.
    result = { status: res.status, text: res.ok ? await res.text() : '', error: '' };
  } catch (e) {
    result = { status: 0, text: '', error: String(e?.message || e) };
  }
  robotsCache.set(origin, result);
  return result;
}

/** AI crawler access for one page: per-bot verdicts plus a 0-100 score (share of search bots allowed). */
export async function aiCrawlerAccess(pageUrl) {
  let url;
  try { url = new URL(pageUrl); } catch { return null; }
  const robots = await fetchRobots(url.origin);
  const groups = parseRobots(robots.text);
  const path = url.pathname + url.search;
  const bots = AI_BOTS.map((b) => ({ ...b, allowed: isAllowed(groups, b.agent, path) }));
  const search = bots.filter((b) => b.kind === 'search');
  const allowedSearch = search.filter((b) => b.allowed).length;
  return {
    robots_status: robots.status,
    robots_error: robots.error,
    score: Math.round((allowedSearch / search.length) * 100),
    blocked_search: bots.filter((b) => b.kind === 'search' && !b.allowed).map((b) => b.agent),
    blocked_training: bots.filter((b) => b.kind === 'training' && !b.allowed).map((b) => b.agent),
    bots,
  };
}
