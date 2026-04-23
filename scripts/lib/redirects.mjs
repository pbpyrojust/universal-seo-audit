export async function traceRedirectChain(url, options = {}) {
  const maxHops = Number(options.maxRedirectHops || 5);
  const headers = { 'user-agent': 'Universal-SEO-Audit Redirect Tracer' };
  const chain = [];
  let current = url;
  const seen = new Set();
  for (let i = 0; i < maxHops; i++) {
    if (seen.has(current)) return { final_url: current, redirect_count: chain.length, redirect_chain: chain, loop: true, status_code: 0 };
    seen.add(current);
    let res;
    try {
      res = await fetch(current, { method: 'HEAD', redirect: 'manual', headers });
      if (res.status === 405 || res.status === 501) res = await fetch(current, { method: 'GET', redirect: 'manual', headers });
    } catch {
      return { final_url: current, redirect_count: chain.length, redirect_chain: chain, loop: false, status_code: 0 };
    }
    const status = Number(res.status || 0);
    if (status >= 300 && status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { final_url: current, redirect_count: chain.length, redirect_chain: chain, loop: false, status_code: status };
      const nextUrl = new URL(loc, current).toString();
      chain.push(`${current} -> ${nextUrl} (${status})`);
      current = nextUrl;
      continue;
    }
    return { final_url: current, redirect_count: chain.length, redirect_chain: chain, loop: false, status_code: status };
  }
  return { final_url: current, redirect_count: chain.length, redirect_chain: chain, loop: false, status_code: 0, too_long: true };
}
