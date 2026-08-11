# Universal SEO Audit

**Version:** 1.5.0

A technical SEO, asset integrity, script inventory, and security audit CLI with visual HTML dashboard, branded PDF reporting, Lighthouse performance scoring, and agentic readiness analysis. Built for development, staging, protected, and noindex sites.

## Features

- Sitemap-first URL discovery with automatic fallback to browser crawl
- Canonical and hreflang validation (missing, duplicate, cross-domain, mismatch)
- Asset integrity checks across images, JS, CSS, fonts, and root files
- Staging/production and `www`/non-`www` asset mismatch detection
- Script inventory and CSP (Content Security Policy) readiness analysis
- Lighthouse/Core Web Vitals performance scoring
- Agentic readiness scoring for browser-native AI agents (WebMCP, accessibility tree, `llms.txt`, layout stability)
- Branded HTML dashboard and PDF report generation
- Run-to-run comparison for tracking fixes over time
- Ticket/backlog generation from audit findings
- Cloudflare/WAF challenge detection with automatic backoff and retry, plus `robots.txt`-aware crawling
- HTTP Basic Auth and form-login support for staging and password-protected sites

## Requirements

- Node.js 20+
- pnpm (recommended) or npm
- Playwright Chromium

## Installation

```bash
pnpm install
pnpm exec playwright install --with-deps chromium
```

## Quick start

Run a full audit:

```bash
node scripts/run-seo-audit.mjs --site https://www.example.com
```

Full audit with Lighthouse performance scoring:

```bash
node scripts/run-seo-audit.mjs --site https://www.example.com --lighthouse
```

Or use the pnpm shortcut:

```bash
pnpm seo-audit --site https://www.example.com --lighthouse
```

## Main audit command

```bash
node scripts/run-seo-audit.mjs --site <url> [options]
```

### Options

| Flag | Description |
|------|-------------|
| `--site <url>` | **(required)** Target website URL |
| `--lighthouse` | Enable Lighthouse performance audits per page |
| `--max-pages <n>` | Limit the number of pages to scan |
| `--crawl` | Use browser link crawling instead of sitemap discovery |
| `--sitemap-url <url>` | Use a specific sitemap URL |
| `--urls-file <path>` | Provide a text file of URLs to audit (one per line) |
| `--include-sitemaps <filter>` | Comma-separated filters for sitemap index entries |
| `--content-sitemaps-only` | Only process common content sitemaps (posts, pages, portfolios, etc.) |
| `--crawl-assets` | With `--crawl`, also crawl media/asset links (images, PDFs, etc.) as pages instead of just checking them |
| `--brand-config <path>` | Path to a branding JSON config for the visual report |
| `--no-visual-report` | Skip HTML dashboard and PDF generation |
| `--max-link-checks <n>` | Cap on unique links checked during link validation (default: `250`) |

#### Bot protection / protected-site options

| Flag | Description |
|------|-------------|
| `--slow` | Conservative scan mode: waits for `domcontentloaded` instead of `networkidle`, adds longer pauses, and defaults retries/backoff higher. Use for sites that are slow, rate-limited, or behind bot protection. |
| `--cloudflare-aware` | Detect Cloudflare/WAF/CAPTCHA challenge pages (and HTTP 403/429/503) and back off + retry instead of scanning the challenge page as real content. |
| `--respect-robots` | Honor `robots.txt` `Disallow` rules and `Crawl-delay` when discovering and crawling URLs. |
| `--retries <n>` | Retry attempts per page navigation (default: `1`, or `2` with `--slow`) |
| `--backoff-ms <n>` | Base backoff delay in ms between retries; doubles each attempt (default: `3000`, or `8000` with `--slow`) |
| `--crawl-delay-ms <n>` | Fixed delay between page visits (default: from `robots.txt` `Crawl-delay`, or `1500` with `--slow`) |

#### Authentication options (staging / password-protected sites)

| Flag | Description |
|------|-------------|
| `--auth-config <path>` | Path to a JSON auth config (see [Authentication for protected sites](#authentication-for-protected-sites)) |
| `--http-username <user>` / `--http-password <pass>` | HTTP Basic Auth credentials |
| `--login-url <url>` | Login page URL for form-based auth |
| `--username <user>` / `--password <pass>` | Form login credentials |
| `--username-selector` / `--password-selector` / `--submit-selector` | CSS selectors for the login form fields (sensible defaults provided) |
| `--ready-selector <selector>` | Selector to wait for after login, confirming the session is ready |
| `--post-login-wait-ms <n>` | Fallback wait after login if `--ready-selector` isn't set (default: `2000`) |

Credentials can also be set via environment variables instead of flags: `USEO_HTTP_USERNAME`, `USEO_HTTP_PASSWORD`, `USEO_LOGIN_USERNAME`, `USEO_LOGIN_PASSWORD`.

### Examples

```bash
# Full sitemap-based scan with Lighthouse
node scripts/run-seo-audit.mjs --site https://www.example.com --lighthouse

# Limit scan to 50 pages
node scripts/run-seo-audit.mjs --site https://www.example.com --max-pages 50

# Use browser crawl mode instead of sitemap discovery
node scripts/run-seo-audit.mjs --site https://www.example.com --crawl --max-pages 50

# Use a specific sitemap
node scripts/run-seo-audit.mjs --site https://www.example.com --sitemap-url https://www.example.com/custom-sitemap.xml

# Audit from a pre-built URL list
node scripts/run-seo-audit.mjs --site https://www.example.com --urls-file ./urls.txt

# WordPress: scan only content sitemaps
node scripts/run-seo-audit.mjs --site https://www.example.com --content-sitemaps-only

# Branded report
node scripts/run-seo-audit.mjs --site https://www.example.com --brand-config ./branding.json

# Protected site behind Cloudflare/WAF: conservative pacing + challenge detection
node scripts/run-seo-audit.mjs --site https://www.example.com --slow --cloudflare-aware --respect-robots

# Password-protected staging site (form login)
node scripts/run-seo-audit.mjs --site https://staging.example.com --auth-config ./auth-config.json
```

## Bot protection / WAF-protected sites

If a scan is being blocked, returns mostly 403/429/503 statuses, or the dashboard shows a wall of `bot_protection_blocked` issues, the site likely has Cloudflare, a WAF, or CAPTCHA in front of it. This tool does not attempt to bypass bot protection or solve CAPTCHAs. Recommended steps, in order:

1. Retry with `--slow --cloudflare-aware` — slower, more human-like pacing plus automatic backoff/retry on challenge pages.
2. Add `--respect-robots` to stay within the site's crawl rules (also reduces the chance of tripping rate limits).
3. If it's still blocked, save the sitemap XML manually from your browser and convert it locally instead of letting the tool fetch it live:
   ```bash
   node scripts/convert-sitemap-xml-to-urls.mjs --input ./saved-sitemap.xml --out ./urls.txt
   ```
4. Run the audit from that URL list instead of live discovery:
   ```bash
   node scripts/run-seo-audit.mjs --site https://www.example.com --urls-file ./urls.txt --slow --cloudflare-aware
   ```

## Output files

Each audit run creates a timestamped folder under `reports/`. The following files are generated:

| File | Description |
|------|-------------|
| `seo-pages.csv` | Per-page data: status codes, titles, canonical status, hreflang coverage |
| `seo-assets.csv` | All discovered assets with status, host, broken/mismatch flags |
| `seo-issues.csv` | All issues found, with type, severity, and details |
| `seo-images.csv` | Per-image alt text data and filename-alt-text detection |
| `seo-social.csv` | Open Graph and Twitter Card metadata per page |
| `seo-structured-data.csv` | JSON-LD/schema, canonical, hreflang, and DOM-weight data per page |
| `seo-crawl-analysis.csv` | Internal link depth, inlink counts, and orphan-page candidates |
| `seo-section-summary.csv` | Page/asset/issue counts grouped by URL path section |
| `seo-asset-host-summary.csv` | Asset counts grouped by host domain |
| `seo-scripts.csv` | Per-page script inventory: inline, external, third-party, event handlers, nonces, CSP flags |
| `seo-csp-summary.csv` | Site-wide CSP summary with suggested `script-src` directive |
| `seo-agentic.csv` | Agentic readiness scores: WebMCP, accessibility tree, llms.txt, layout stability |
| `seo-lighthouse.csv` | Lighthouse scores per page (when `--lighthouse` is enabled) |
| `seo-report.json` | All page/issue/image/structured/social/agentic data combined as JSON |
| `seo-run-metadata.json` | Run summary: counts, timing, and top issue types |
| `seo-dashboard.html` | Visual HTML dashboard with all findings |
| `seo-dashboard.pdf` | PDF version of the dashboard |
| `urls.txt` | Discovered URLs from the sitemap |

## Audits included

### SEO & metadata
- Page status codes (2xx, 3xx, 4xx, 5xx)
- Title tag presence
- Canonical tag validation (missing, duplicate, cross-domain, mismatch, invalid)
- Hreflang tag validation (missing, invalid, duplicate values, x-default presence)

### Asset integrity
- Broken asset detection (images, JS, CSS, fonts)
- Host mismatch detection (asset served from unexpected domain)
- `www`/non-`www` mismatch detection
- Staging/production environment mixup detection
- Protocol mismatch (HTTP vs HTTPS)
- CDN inconsistency warnings

### Script audit & CSP readiness
- External script count and domains (first-party vs third-party)
- Inline script count with `eval()`, `document.write()`, and `innerHTML` detection
- Inline event handler count (`onclick`, `onload`, etc.)
- `javascript:` URI link detection
- Nonce and Subresource Integrity (SRI) attribute checks
- Async/defer vs render-blocking script classification
- Per-page and site-wide CSP `script-src` directive generation
- Issues flagged:
  - `script_uses_eval` (high) -- forces `unsafe-eval` in CSP
  - `script_uses_document_write` (medium) -- parser-blocking
  - `script_no_nonces` (medium) -- forces `unsafe-inline` in CSP
  - `excessive_inline_event_handlers` (medium) -- >5 inline handlers
  - `excessive_third_party_scripts` (medium) -- >10 third-party scripts
  - `render_blocking_scripts` (low) -- >3 render-blocking scripts
  - `javascript_href_links` (low) -- `javascript:` URIs in links

### Lighthouse performance (optional)
- Performance score
- Largest Contentful Paint (LCP)
- Cumulative Layout Shift (CLS)
- Total Blocking Time (TBT)
- First Contentful Paint (FCP)
- Speed Index (SI)

### Agentic readiness
- WebMCP protocol detection (`navigator.modelContext.registerTool()`)
- Accessibility tree label coverage for form controls and clickable elements
- `/llms.txt` presence, structure, and content analysis
- Layout stability scoring (CLS + explicit media sizing)

## Additional scripts

### Compare two audit runs

Diff two runs to see new, fixed, and persistent issues:

```bash
node scripts/compare-seo-runs.mjs --before reports/run-a --after reports/run-b
```

Optionally specify a separate output directory:

```bash
node scripts/compare-seo-runs.mjs --before reports/run-a --after reports/run-b --out-dir reports/comparison
```

### Generate a text report from audit data

Produces a human-readable summary report from a completed audit run:

```bash
node scripts/generate-seo-report.mjs --run-dir reports/<run-folder> --site https://www.example.com
```

### Generate tickets/backlog items

Creates actionable tickets from audit issues, grouped by page and by global issue type:

```bash
node scripts/generate-seo-tickets.mjs --run-dir reports/<run-folder>
```

### Regenerate the visual dashboard

Re-render the HTML dashboard and PDF from existing CSV data (useful after manual edits or with updated branding):

```bash
node scripts/generate-visual-report.mjs --run-dir reports/<run-folder> --site https://www.example.com
node scripts/generate-visual-report.mjs --run-dir reports/<run-folder> --site https://www.example.com --brand-config ./branding.json
```

### Build a URL list from a sitemap

Discover and export all URLs from a site's sitemap without running an audit:

```bash
node scripts/build-urls-from-sitemap.mjs --site https://www.example.com --out ./urls.txt
```

Options:

| Flag | Description |
|------|-------------|
| `--site <url>` | **(required)** Target website |
| `--out <path>` | Output file path (default: `./urls.txt`) |
| `--sitemap-url <url>` | Use a specific sitemap URL |
| `--include-sitemaps <filter>` | Comma-separated filters for sitemap index entries |
| `--content-sitemaps-only` | Only include content-type sitemaps |

### Convert a saved sitemap XML to a URL list

Extract URLs from a locally saved sitemap XML file:

```bash
node scripts/convert-sitemap-xml-to-urls.mjs --input ./saved-sitemap.xml --out ./urls.txt
```

## Branded reports

Create a JSON config from `branding.example.json`:

```json
{
  "companyName": "Your Company",
  "logo": "./assets/logo.png",
  "primaryColor": "#0ea5e9",
  "secondaryColor": "#111827",
  "accentColor": "#22c55e",
  "reportTitle": "Technical SEO & Site Health Audit",
  "author": "Your Name",
  "footerText": "Confidential — Prepared by Your Company"
}
```

Then pass it to the audit:

```bash
node scripts/run-seo-audit.mjs --site https://www.example.com --brand-config ./branding.json
```

## Authentication for protected sites

For staging or password-protected sites, create an auth config from `auth-config.example.json`:

```json
{
  "loginUrl": "https://staging.example.com/login",
  "username": "your-username",
  "password": "your-password",
  "usernameSelector": "input[name='username'], input[type='email']",
  "passwordSelector": "input[name='password'], input[type='password']",
  "submitSelector": "button[type='submit'], input[type='submit']",
  "readySelector": "body",
  "postLoginWaitMs": 2000
}
```

Then run the audit with `--auth-config`:

```bash
node scripts/run-seo-audit.mjs --site https://staging.example.com --auth-config ./auth-config.json
```

For sites behind HTTP Basic Auth instead of a login form, use `httpUsername`/`httpPassword` in the config (or `--http-username`/`--http-password` directly) instead of `loginUrl`. See [Options](#options) above for the full list of auth flags and equivalent environment variables.

## Stability notes

- Some sites trigger client-side redirects, lazy hydration, or page refreshes during DOM extraction. The runner retries extraction once and records a `page_extraction_error` issue instead of crashing the full audit.
- When `--lighthouse` is enabled on a large sitemap, the scan can take a long time. Use `--max-pages` to limit Lighthouse to a sample if needed.
- Pages blocked by bot protection are recorded as a `bot_protection_blocked` issue rather than failing the run; see [Bot protection / WAF-protected sites](#bot-protection--waf-protected-sites).
- With `--auth-config` and a large scan, the browser context is recycled every 25 pages to manage memory; the tool automatically re-runs form login after each recycle so the session stays authenticated.
