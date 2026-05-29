const llmsTxtCache = new Map();

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function scoreLabel(score) {
  if (score >= 90) return "excellent";
  if (score >= 75) return "good";
  if (score >= 50) return "needs_work";
  return "poor";
}

function originFor(url) {
  try { return new URL(url).origin; } catch { return ""; }
}

async function fetchLlmsTxt(pageUrl) {
  const origin = originFor(pageUrl);
  if (!origin) return { url: "", status: 0, present: false, bytes: 0, headings: 0, links: 0, error: "invalid_url" };
  if (llmsTxtCache.has(origin)) return llmsTxtCache.get(origin);

  const llmsUrl = `${origin}/llms.txt`;
  let result;
  try {
    const res = await fetch(llmsUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "Universal-SEO-Audit Agentic Readiness",
        "accept": "text/plain, text/markdown, */*"
      }
    });
    const text = await res.text();
    const contentType = res.headers.get("content-type") || "";
    const markdownHeadings = (text.match(/^#{1,3}\s+\S.+$/gm) || []).length;
    const markdownLinks = (text.match(/\[[^\]]+\]\([^)]+\)/g) || []).length;
    result = {
      url: llmsUrl,
      status: res.status,
      present: res.ok && text.trim().length > 0,
      bytes: Buffer.byteLength(text || "", "utf8"),
      headings: markdownHeadings,
      links: markdownLinks,
      content_type: contentType,
      error: ""
    };
  } catch (e) {
    result = {
      url: llmsUrl,
      status: 0,
      present: false,
      bytes: 0,
      headings: 0,
      links: 0,
      content_type: "",
      error: String(e?.message || e)
    };
  }
  llmsTxtCache.set(origin, result);
  return result;
}

export async function installWebMcpCapture(context) {
  await context.addInitScript(() => {
    window.__useoWebMcpTools = [];
    const wrap = () => {
      const modelContext = navigator.modelContext;
      if (!modelContext || typeof modelContext.registerTool !== "function" || modelContext.__useoWrappedRegisterTool) return;
      const original = modelContext.registerTool.bind(modelContext);
      modelContext.registerTool = (...args) => {
        try {
          const tool = args[0] || {};
          window.__useoWebMcpTools.push({
            name: tool.name || "",
            description: tool.description || "",
            hasInputSchema: Boolean(tool.inputSchema || tool.schema || tool.parameters),
            hasHandler: typeof tool.handler === "function" || typeof args[1] === "function"
          });
        } catch {}
        return original(...args);
      };
      modelContext.__useoWrappedRegisterTool = true;
    };
    wrap();
    document.addEventListener("DOMContentLoaded", wrap, { once: true });
  });
}

export async function collectAgenticSignals(page, pageUrl, lighthouseRow = {}) {
  const [dom, llms] = await Promise.all([
    page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll("button,input,select,textarea,a[href],[role='button'],[role='link'],[role='menuitem'],[role='option'],[tabindex]"));
      const formControls = Array.from(document.querySelectorAll("input,select,textarea"));
      const namedFormControls = formControls.filter((el) => {
        const id = el.getAttribute("id");
        const ariaLabel = el.getAttribute("aria-label");
        const ariaLabelledby = el.getAttribute("aria-labelledby");
        const title = el.getAttribute("title");
        const placeholder = el.getAttribute("placeholder");
        const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        return Boolean(ariaLabel || ariaLabelledby || title || placeholder || label || el.closest("label"));
      });
      const clickable = controls.filter((el) => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();
        return tag === "button" || tag === "a" || el.getAttribute("role") || ["button","submit","reset","checkbox","radio"].includes(type);
      });
      const namedClickable = clickable.filter((el) => {
        const text = (el.innerText || el.textContent || "").trim();
        return Boolean(text || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || el.querySelector("img[alt]"));
      });
      const visibleImages = Array.from(document.images).filter((img) => img.getBoundingClientRect().width > 1 && img.getBoundingClientRect().height > 1);
      const imagesWithDimensions = visibleImages.filter((img) => img.getAttribute("width") || img.getAttribute("height") || img.style.aspectRatio || img.closest("[style*='aspect-ratio']"));
      const webMcpReferences = Array.from(document.querySelectorAll("script")).filter((script) => {
        const src = script.src || "";
        const text = script.textContent || "";
        return /webmcp|modelContext|registerTool/i.test(src) || /navigator\.modelContext|registerTool\s*\(/i.test(text);
      }).length;
      const capturedTools = Array.isArray(window.__useoWebMcpTools) ? window.__useoWebMcpTools : [];
      const toolLikeElements = Array.from(document.querySelectorAll("[data-tool],[data-action],[data-agent-action],[tool-param-description],form[action],button[name],input[name]")).length;
      const hasFunctionalHints = /(cart|checkout|filter|sort|search|booking|reserve|compare|wishlist|add-to-cart)/i.test(document.body?.innerText || "");
      return {
        has_model_context_api: Boolean(navigator.modelContext),
        captured_tools_count: capturedTools.length,
        captured_tools_with_schema: capturedTools.filter((t) => t.hasInputSchema).length,
        captured_tool_names: capturedTools.map((t) => t.name).filter(Boolean).slice(0, 12).join(" | "),
        webmcp_reference_count: webMcpReferences,
        tool_like_element_count: toolLikeElements,
        functional_hint_present: hasFunctionalHints,
        form_control_count: formControls.length,
        named_form_control_count: namedFormControls.length,
        clickable_count: clickable.length,
        named_clickable_count: namedClickable.length,
        visible_image_count: visibleImages.length,
        images_with_dimensions_count: imagesWithDimensions.length
      };
    }),
    fetchLlmsTxt(pageUrl)
  ]);

  const formNameRate = dom.form_control_count ? dom.named_form_control_count / dom.form_control_count : 1;
  const clickableNameRate = dom.clickable_count ? dom.named_clickable_count / dom.clickable_count : 1;
  const imageDimensionRate = dom.visible_image_count ? dom.images_with_dimensions_count / dom.visible_image_count : 1;
  const rawCls = lighthouseRow.cls ?? lighthouseRow.cumulative_layout_shift;
  const hasCls = rawCls !== undefined && rawCls !== "" && Number.isFinite(Number(rawCls));
  const cls = hasCls ? Number(rawCls) : "";

  const webMcpScore = clampScore(
    (dom.captured_tools_count > 0 ? 55 : 0) +
    (dom.captured_tools_with_schema > 0 ? 25 : 0) +
    (dom.webmcp_reference_count > 0 ? 10 : 0) +
    (dom.functional_hint_present && dom.tool_like_element_count > 0 ? 10 : 0)
  );
  const accessibilityScore = clampScore((formNameRate * 50) + (clickableNameRate * 50));
  const semanticScore = clampScore(
    (llms.present ? 55 : 0) +
    (llms.bytes >= 300 ? 20 : llms.bytes > 0 ? 10 : 0) +
    (llms.headings > 0 ? 15 : 0) +
    (llms.links > 0 ? 10 : 0)
  );
  const clsScore = !hasCls ? null : cls <= 0 ? 100 : cls <= 0.1 ? 95 : cls <= 0.25 ? 70 : cls <= 0.5 ? 40 : 15;
  const layoutScore = clampScore(hasCls ? ((clsScore * 0.75) + (imageDimensionRate * 25)) : (imageDimensionRate * 100));
  const agenticScore = clampScore((webMcpScore * 0.25) + (accessibilityScore * 0.30) + (semanticScore * 0.25) + (layoutScore * 0.20));

  return {
    page_url: pageUrl,
    agentic_score: agenticScore,
    agentic_grade: scoreLabel(agenticScore),
    webmcp_protocol_score: webMcpScore,
    webmcp_tools_registered: dom.captured_tools_count,
    webmcp_tools_with_schema: dom.captured_tools_with_schema,
    webmcp_reference_count: dom.webmcp_reference_count,
    webmcp_tool_names: dom.captured_tool_names,
    accessibility_tree_score: accessibilityScore,
    form_control_count: dom.form_control_count,
    named_form_control_count: dom.named_form_control_count,
    clickable_count: dom.clickable_count,
    named_clickable_count: dom.named_clickable_count,
    semantic_data_score: semanticScore,
    llms_txt_present: yesNo(llms.present),
    llms_txt_url: llms.url,
    llms_txt_status: llms.status,
    llms_txt_bytes: llms.bytes,
    llms_txt_headings: llms.headings,
    llms_txt_links: llms.links,
    layout_stability_score: layoutScore,
    cls,
    visible_image_count: dom.visible_image_count,
    images_with_dimensions_count: dom.images_with_dimensions_count,
    note: llms.error ? `llms.txt fetch failed: ${llms.error}` : ""
  };
}

export function agenticIssueFindings(row) {
  const findings = [];
  if (Number(row.webmcp_protocol_score || 0) < 50) findings.push({
    issue_type: "webmcp_tools_missing",
    severity: "medium",
    details: "No functional WebMCP tool registration was detected for browser-native AI agents.",
    recommendation: "Expose key actions such as search, filtering, cart, booking, or checkout through navigator.modelContext.registerTool() with schemas."
  });
  if (Number(row.accessibility_tree_score || 0) < 75) findings.push({
    issue_type: "accessibility_tree_labels_incomplete",
    severity: "high",
    details: `${row.named_form_control_count}/${row.form_control_count} form controls and ${row.named_clickable_count}/${row.clickable_count} clickable controls have detectable labels.`,
    recommendation: "Add precise visible text, associated labels, aria-label, aria-labelledby, or title values for controls agents need to operate."
  });
  if (row.llms_txt_present !== "yes") findings.push({
    issue_type: "llms_txt_missing",
    severity: "medium",
    details: `No usable llms.txt file was found at ${row.llms_txt_url}.`,
    recommendation: "Add /llms.txt with concise platform guidance, important URLs, policies, and limits for LLM and browser-agent use."
  });
  if (Number(row.layout_stability_score || 0) < 75) findings.push({
    issue_type: "agentic_layout_unstable",
    severity: "high",
    details: `Layout stability score is ${row.layout_stability_score}; CLS is ${row.cls}.`,
    recommendation: "Reserve space for media and injected UI, avoid late-loading layout shifts, and keep actionable controls stable during automation."
  });
  return findings;
}
