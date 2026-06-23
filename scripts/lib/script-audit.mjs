const EVENT_HANDLER_ATTRS = [
  'onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmouseover', 'onmouseout',
  'onkeydown', 'onkeyup', 'onkeypress', 'onchange', 'onsubmit', 'onfocus', 'onblur',
  'onload', 'onerror', 'onresize', 'onscroll', 'oninput', 'ontouchstart', 'ontouchend'
];

export async function collectScriptInventory(page, pageUrl) {
  const data = await page.evaluate((handlerAttrs) => {
    const externalScripts = [];
    const inlineScripts = [];

    document.querySelectorAll('script').forEach((el) => {
      const src = el.src || el.getAttribute('src') || '';
      if (src) {
        externalScripts.push({
          src,
          async: el.async,
          defer: el.defer,
          type: el.getAttribute('type') || '',
          crossorigin: el.getAttribute('crossorigin') || '',
          integrity: el.getAttribute('integrity') || '',
          nonce: el.getAttribute('nonce') || '',
          id: el.id || ''
        });
      } else {
        const content = (el.textContent || '').trim();
        if (content) {
          inlineScripts.push({
            type: el.getAttribute('type') || '',
            nonce: el.getAttribute('nonce') || '',
            id: el.id || '',
            length: content.length,
            usesEval: /\beval\s*\(/.test(content),
            usesDocumentWrite: /document\.write\s*\(/.test(content),
            usesInnerHTML: /\.innerHTML\s*=/.test(content),
            snippet: content.slice(0, 120)
          });
        }
      }
    });

    let inlineEventHandlerCount = 0;
    const inlineHandlerElements = [];
    const selectorParts = handlerAttrs.map((a) => `[${a}]`).join(',');
    document.querySelectorAll(selectorParts).forEach((el) => {
      for (const attr of handlerAttrs) {
        if (el.hasAttribute(attr)) {
          inlineEventHandlerCount++;
          if (inlineHandlerElements.length < 10) {
            inlineHandlerElements.push({
              tag: el.tagName.toLowerCase(),
              attr,
              value: (el.getAttribute(attr) || '').slice(0, 80)
            });
          }
        }
      }
    });

    const javascriptLinks = Array.from(document.querySelectorAll('a[href^="javascript:"]')).length;

    return {
      externalScripts,
      inlineScripts,
      inlineEventHandlerCount,
      inlineHandlerElements,
      javascriptLinks
    };
  }, EVENT_HANDLER_ATTRS);

  const pageOrigin = (() => { try { return new URL(pageUrl).origin; } catch { return ''; } })();

  const scriptDomains = new Map();
  for (const s of data.externalScripts) {
    try {
      const u = new URL(s.src, pageUrl);
      const domain = u.hostname;
      if (!scriptDomains.has(domain)) {
        scriptDomains.set(domain, { domain, count: 0, isFirstParty: false, urls: [] });
      }
      const entry = scriptDomains.get(domain);
      entry.count++;
      if (entry.urls.length < 5) entry.urls.push(u.toString());
      try {
        entry.isFirstParty = new URL(pageUrl).hostname.replace(/^www\./, '') === domain.replace(/^www\./, '');
      } catch {}
    } catch {}
  }

  const hasUnsafeInline = data.inlineScripts.length > 0 || data.inlineEventHandlerCount > 0 || data.javascriptLinks > 0;
  const hasUnsafeEval = data.inlineScripts.some((s) => s.usesEval);
  const allHaveNonces = data.inlineScripts.length > 0 && data.inlineScripts.every((s) => s.nonce);
  const allExternalHaveIntegrity = data.externalScripts.length > 0 && data.externalScripts.every((s) => s.integrity);

  const domains = Array.from(scriptDomains.values());
  const firstPartyDomains = domains.filter((d) => d.isFirstParty);
  const thirdPartyDomains = domains.filter((d) => !d.isFirstParty);

  const cspDirectiveParts = ["'self'"];
  for (const d of thirdPartyDomains) {
    cspDirectiveParts.push(`https://${d.domain}`);
  }
  if (hasUnsafeInline && !allHaveNonces) cspDirectiveParts.push("'unsafe-inline'");
  if (hasUnsafeEval) cspDirectiveParts.push("'unsafe-eval'");
  const suggestedScriptSrc = `script-src ${cspDirectiveParts.join(' ')}`;

  return {
    page_url: pageUrl,
    external_script_count: data.externalScripts.length,
    inline_script_count: data.inlineScripts.length,
    total_script_count: data.externalScripts.length + data.inlineScripts.length,
    inline_event_handler_count: data.inlineEventHandlerCount,
    javascript_link_count: data.javascriptLinks,
    first_party_script_domains: firstPartyDomains.map((d) => d.domain).join(' | '),
    first_party_script_count: firstPartyDomains.reduce((a, d) => a + d.count, 0),
    third_party_script_domains: thirdPartyDomains.map((d) => d.domain).join(' | '),
    third_party_script_count: thirdPartyDomains.reduce((a, d) => a + d.count, 0),
    unique_script_domains: domains.length,
    uses_eval: data.inlineScripts.some((s) => s.usesEval) ? 'yes' : 'no',
    uses_document_write: data.inlineScripts.some((s) => s.usesDocumentWrite) ? 'yes' : 'no',
    uses_innerhtml: data.inlineScripts.some((s) => s.usesInnerHTML) ? 'yes' : 'no',
    all_inline_have_nonce: allHaveNonces ? 'yes' : 'no',
    all_external_have_integrity: allExternalHaveIntegrity ? 'yes' : 'no',
    async_script_count: data.externalScripts.filter((s) => s.async).length,
    defer_script_count: data.externalScripts.filter((s) => s.defer).length,
    render_blocking_script_count: data.externalScripts.filter((s) => !s.async && !s.defer).length,
    needs_unsafe_inline: hasUnsafeInline && !allHaveNonces ? 'yes' : 'no',
    needs_unsafe_eval: hasUnsafeEval ? 'yes' : 'no',
    suggested_script_src: suggestedScriptSrc,
    external_scripts: data.externalScripts,
    inline_handler_samples: data.inlineHandlerElements
  };
}

export function scriptAuditIssueFindings(row) {
  const findings = [];

  if (row.needs_unsafe_eval === 'yes') {
    findings.push({
      issue_type: 'script_uses_eval',
      severity: 'high',
      details: `Inline scripts on this page use eval(). This forces unsafe-eval in CSP, weakening script injection protections.`
    });
  }

  if (row.uses_document_write === 'yes') {
    findings.push({
      issue_type: 'script_uses_document_write',
      severity: 'medium',
      details: 'Inline scripts use document.write(), which blocks parsing and is blocked by some browsers on slow connections.'
    });
  }

  if (row.needs_unsafe_inline === 'yes' && row.inline_script_count > 0) {
    findings.push({
      issue_type: 'script_no_nonces',
      severity: 'medium',
      details: `${row.inline_script_count} inline script(s) lack nonce attributes. CSP will require unsafe-inline unless nonces or hashes are added.`
    });
  }

  if (row.inline_event_handler_count > 5) {
    findings.push({
      issue_type: 'excessive_inline_event_handlers',
      severity: 'medium',
      details: `${row.inline_event_handler_count} inline event handlers (onclick, onload, etc.) detected. These require unsafe-inline in CSP and are better moved to external scripts.`
    });
  }

  if (row.third_party_script_count > 10) {
    findings.push({
      issue_type: 'excessive_third_party_scripts',
      severity: 'medium',
      details: `${row.third_party_script_count} third-party scripts from ${row.unique_script_domains - (row.first_party_script_count > 0 ? 1 : 0)} domain(s) detected. Each domain must be allowlisted in CSP and increases attack surface.`
    });
  }

  if (row.render_blocking_script_count > 3) {
    findings.push({
      issue_type: 'render_blocking_scripts',
      severity: 'low',
      details: `${row.render_blocking_script_count} render-blocking scripts (no async/defer). Consider adding async or defer to improve page load.`
    });
  }

  if (row.javascript_link_count > 0) {
    findings.push({
      issue_type: 'javascript_href_links',
      severity: 'low',
      details: `${row.javascript_link_count} link(s) use javascript: URIs. These require unsafe-inline in CSP and hurt accessibility.`
    });
  }

  return findings;
}

export function buildCspSummary(allScriptRows, siteOrigin) {
  const allThirdPartyDomains = new Set();
  let needsUnsafeInline = false;
  let needsUnsafeEval = false;
  let totalExternal = 0;
  let totalInline = 0;
  let totalHandlers = 0;
  let totalJsLinks = 0;
  let totalRenderBlocking = 0;
  let pagesWithEval = 0;
  let pagesWithDocWrite = 0;

  for (const row of allScriptRows) {
    totalExternal += row.external_script_count;
    totalInline += row.inline_script_count;
    totalHandlers += row.inline_event_handler_count;
    totalJsLinks += row.javascript_link_count;
    totalRenderBlocking += row.render_blocking_script_count;
    if (row.needs_unsafe_inline === 'yes') needsUnsafeInline = true;
    if (row.needs_unsafe_eval === 'yes') { needsUnsafeEval = true; pagesWithEval++; }
    if (row.uses_document_write === 'yes') pagesWithDocWrite++;
    if (row.third_party_script_domains) {
      for (const d of row.third_party_script_domains.split(' | ')) {
        if (d.trim()) allThirdPartyDomains.add(d.trim());
      }
    }
  }

  const cspParts = ["'self'"];
  for (const d of [...allThirdPartyDomains].sort()) {
    cspParts.push(`https://${d}`);
  }
  if (needsUnsafeInline) cspParts.push("'unsafe-inline'");
  if (needsUnsafeEval) cspParts.push("'unsafe-eval'");

  return {
    pages_audited: allScriptRows.length,
    total_external_scripts: totalExternal,
    total_inline_scripts: totalInline,
    total_inline_event_handlers: totalHandlers,
    total_javascript_links: totalJsLinks,
    total_render_blocking: totalRenderBlocking,
    unique_third_party_domains: allThirdPartyDomains.size,
    third_party_domains: [...allThirdPartyDomains].sort().join(' | '),
    needs_unsafe_inline: needsUnsafeInline ? 'yes' : 'no',
    needs_unsafe_eval: needsUnsafeEval ? 'yes' : 'no',
    pages_with_eval: pagesWithEval,
    pages_with_document_write: pagesWithDocWrite,
    suggested_script_src: `script-src ${cspParts.join(' ')}`
  };
}
