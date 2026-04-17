# Universal SEO Audit

**Version:** 0.5.1

Universal SEO Audit is a production-oriented technical SEO audit CLI for development, staging, protected, and noindex sites.

It is built for the situations where external crawlers often fall short: password-protected staging environments, development sites behind login, sites intentionally using `noindex`, and pre-launch environments where you still need a real technical SEO crawl.

The tool renders pages in a real browser with Playwright, builds URL lists from sitemaps, supports protected-site authentication, and produces page-level CSVs, issue CSVs, technical analysis outputs, markdown summaries, and ticket-ready backlog files.

## What the tool is for

Use Universal SEO Audit when you need to:

- audit a site before launch
- audit a staging or development site behind auth
- validate metadata, canonical setup, robots directives, and schema before a public crawl is possible
- generate a technical SEO issue backlog for developers, content teams, or PMs
- compare sitemap-discovered pages with the actual rendered crawl output

## What it audits

### Core technical SEO
- HTTP status codes
- titles
- meta descriptions
- robots meta and `X-Robots-Tag`
- canonicals
- H1s and heading outline
- basic content/word-count signals

### Crawl and linking analysis
- broken internal links
- broken external links
- internal link depth analysis
- sitemap vs crawl comparison
- orphan-page detection within the scanned set

### Content and duplication analysis
- duplicate titles
- duplicate meta descriptions
- duplicate-content clustering by body similarity
- thin-content flags

### Structured data and international signals
- JSON-LD/schema presence
- JSON-LD parse validity
- schema type extraction
- schema type validation heuristics
- html `lang`
- hreflang presence and invalid entries

### Social/share coverage
- `og:title`
- `og:description`
- `og:image`
- `og:url`
- share-image coverage reporting

### Lightweight render diagnostics
- DOM node count
- resource count
- stylesheet count
- script count
- render-blocking asset heuristics

### Optional deeper diagnostics
- optional Lighthouse integration
- canonical/redirect chain analysis (workflow extension target)

## Outputs

Each run writes to a site-name + timestamp folder, for example:

```text
reports/
  example.com-20260416-141010/
    urls.txt
    seo-pages.csv
    seo-issues.csv
    seo-images.csv
    seo-structured-data.csv
    seo-social.csv
    seo-crawl-analysis.csv
    seo-summary-google-doc.md
    seo-ticket-backlog.csv
    seo-report.json
    seo-run-metadata.json
```

### Output file overview

- `seo-pages.csv` — one row per scanned page with key page-level SEO fields
- `seo-issues.csv` — one row per detected SEO issue
- `seo-images.csv` — image alt/filename inventory
- `seo-structured-data.csv` — structured-data, lang, viewport, hreflang, and technical render diagnostics
- `seo-social.csv` — Open Graph/social-sharing coverage
- `seo-crawl-analysis.csv` — crawl-diff/link-depth/orphan-style analysis
- `seo-summary-google-doc.md` — docs-ready narrative summary
- `seo-ticket-backlog.csv` — ticket/backlog import file
- `seo-report.json` — raw consolidated audit output
- `seo-run-metadata.json` — counts and summary stats for the run

## Requirements

- Node.js 20+
- pnpm
- Playwright Chromium

Install:

```bash
pnpm install
pnpm exec playwright install --with-deps chromium
```

## Main commands

### Standard full audit
```bash
node scripts/run-seo-audit.mjs --site https://www.example.com
```

### Include all sitemap sources
```bash
node scripts/run-seo-audit.mjs \
  --site https://www.example.com \
  --include-all-sitemaps
```

### Use a provided URL list
```bash
node scripts/run-seo-audit.mjs \
  --site https://www.example.com \
  --urls-file ./reports/manual-urls.txt
```

### Protected-site conservative run
```bash
node scripts/run-seo-audit.mjs \
  --site https://staging.example.com \
  --slow \
  --respect-robots \
  --cloudflare-aware
```

### Basic auth
```bash
node scripts/run-seo-audit.mjs \
  --site https://staging.example.com \
  --http-username your-user \
  --http-password your-pass
```

### Form-login config
```bash
node scripts/run-seo-audit.mjs \
  --site https://staging.example.com \
  --auth-config ./auth.local.json
```

### Small-batch protected-site test
```bash
node scripts/run-seo-audit.mjs \
  --site https://staging.example.com \
  --auth-config ./auth.local.json \
  --slow \
  --respect-robots \
  --cloudflare-aware \
  --batch-size 10
```

### Optional Lighthouse-enabled run
```bash
node scripts/run-seo-audit.mjs \
  --site https://www.example.com \
  --lighthouse
```

## Supported flags

### Scope and crawl control
- `--site`
- `--urls-file`
- `--sitemap-url`
- `--include-sitemaps`
- `--include-all-sitemaps`
- `--batch-size`
- `--crawl`
- `--max-pages`

### Protected-site / conservative scanning
- `--slow`
- `--respect-robots`
- `--cloudflare-aware`
- `--retries`
- `--backoff-ms`
- `--crawl-delay-ms`

### Authentication
- `--http-username`
- `--http-password`
- `--auth-config`
- `--login-url`
- `--username`
- `--password`
- `--username-selector`
- `--password-selector`
- `--submit-selector`
- `--ready-selector`
- `--post-login-wait-ms`

### Analysis options
- `--max-link-checks`
- `--lighthouse`

## Authentication for protected sites

Environment variables are also supported:

- `USEO_HTTP_USERNAME`
- `USEO_HTTP_PASSWORD`
- `USEO_LOGIN_USERNAME`
- `USEO_LOGIN_PASSWORD`

## Typical use cases

- pre-launch SEO QA
- launch-readiness audits on staging
- technical SEO cleanup backlog generation
- metadata/schema/canonical validation before public crawlability
- browser-based crawling of sites external crawlers cannot reliably audit

## Security and local-only files

Do **not** commit:
- real auth config files
- `.env` files
- real client report folders
- saved sitemap XML exports from private sites
- tokens or secret headers

The repo ignores the common risky local files already.
