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
| `--brand-config <path>` | Path to a branding JSON config for the visual report |
| `--no-visual-report` | Skip HTML dashboard and PDF generation |

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
```

## Output files

Each audit run creates a timestamped folder under `reports/`. The following files are generated:

| File | Description |
|------|-------------|
| `seo-pages.csv` | Per-page data: status codes, titles, canonical status, hreflang coverage |
| `seo-assets.csv` | All discovered assets with status, host, broken/mismatch flags |
| `seo-issues.csv` | All issues found, with type, severity, and details |
| `seo-section-summary.csv` | Page/asset/issue counts grouped by URL path section |
| `seo-asset-host-summary.csv` | Asset counts grouped by host domain |
| `seo-scripts.csv` | Per-page script inventory: inline, external, third-party, event handlers, nonces, CSP flags |
| `seo-csp-summary.csv` | Site-wide CSP summary with suggested `script-src` directive |
| `seo-agentic.csv` | Agentic readiness scores: WebMCP, accessibility tree, llms.txt, layout stability |
| `seo-lighthouse.csv` | Lighthouse scores per page (when `--lighthouse` is enabled) |
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

## Stability notes

- Some sites trigger client-side redirects, lazy hydration, or page refreshes during DOM extraction. The runner retries extraction once and records a `page_extraction_error` issue instead of crashing the full audit.
- When `--lighthouse` is enabled on a large sitemap, the scan can take a long time. Use `--max-pages` to limit Lighthouse to a sample if needed.
