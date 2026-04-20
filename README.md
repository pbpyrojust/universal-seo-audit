# Universal SEO Audit

**Version:** 0.8.1

Universal SEO Audit is a production-oriented technical SEO audit CLI for development, staging, protected, and noindex sites.

It is built for situations where external crawlers often cannot access or fully render a site, including password-protected staging environments, dev sites behind login, intentionally non-indexed environments, and browser-rendered sites that need pre-launch QA.

The tool renders pages with Playwright, builds URL lists from sitemaps, supports protected-site authentication, and produces page-level CSVs, issue CSVs, crawl-analysis outputs, markdown summaries, ticket-ready backlog files, and now run-comparison outputs, richer social/schema validation, render-blocking heuristics, and lightweight performance reporting.

## What it audits

### Core technical SEO
- HTTP status codes
- titles
- meta descriptions
- robots meta and `X-Robots-Tag`
- canonicals
- H1s and heading outline
- indexability status

### Crawl and linking analysis
- broken internal links
- broken external links
- internal link depth
- inlink counts
- orphan-page candidates
- section-level crawl summaries
- sitemap-only candidates within the scanned set

### Content and duplication analysis
- duplicate titles
- duplicate meta descriptions
- duplicate-content clustering by body similarity
- thin-content flags

### Structured data and international signals
- JSON-LD/schema presence
- JSON-LD parse validity
- schema type extraction
- missing schema type heuristics
- html `lang`
- hreflang validity

### Social/share coverage
- `og:title`
- `og:description`
- `og:image`
- `og:url`
- twitter cards and twitter share image fields

### Redirect/canonical analysis
- redirect count
- redirect chain
- canonical status
- final URL vs canonical comparison

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
    seo-section-summary.csv
    seo-summary-google-doc.md
    seo-ticket-backlog.csv
    seo-report.json
    seo-run-metadata.json
```

### Additional v0.7 outputs
- `seo-section-summary.csv` — rollup by top URL section
- `seo-compare-summary.csv` — issue deltas between two runs
- `seo-compare-new-issues.csv`
- `seo-compare-resolved-issues.csv`
- `seo-compare-summary.md`

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

### Use a config file
```bash
node scripts/run-seo-audit.mjs --config ./useo.config.json
```

If `useo.config.json` exists in the project root, it will be used automatically unless you override with explicit CLI flags.

### Include all sitemap sources
```bash
node scripts/run-seo-audit.mjs   --site https://www.example.com   --include-all-sitemaps
```

### Use a provided URL list
```bash
node scripts/run-seo-audit.mjs   --site https://www.example.com   --urls-file ./reports/manual-urls.txt
```

### Protected-site conservative run
```bash
node scripts/run-seo-audit.mjs   --site https://staging.example.com   --slow   --respect-robots   --cloudflare-aware
```

### Basic auth
```bash
node scripts/run-seo-audit.mjs   --site https://staging.example.com   --http-username your-user   --http-password your-pass
```

### Form-login config
```bash
node scripts/run-seo-audit.mjs   --site https://staging.example.com   --auth-config ./auth.local.json
```

### Compare two runs
```bash
node scripts/compare-seo-runs.mjs   --before reports/example.com-20260416-141010   --after reports/example.com-20260420-101500
```

## Supported flags

### Scope and crawl control
- `--site`
- `--config`
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
- `--duplicate-threshold`
- `--max-redirect-hops`
- `--priority-model`
- `--no-duplicate-clustering`

## Config file

Example config:

```json
{
  "site": "https://www.example.com",
  "include-all-sitemaps": true,
  "slow": false,
  "respect-robots": false,
  "cloudflare-aware": false,
  "batch-size": 0,
  "max-link-checks": 250,
  "duplicate-threshold": 0.85,
  "max-redirect-hops": 5,
  "priority-model": "default"
}
```

A committed example file is included as `useo.config.example.json`.

## Auth for protected sites

Environment variables are also supported:
- `USEO_HTTP_USERNAME`
- `USEO_HTTP_PASSWORD`
- `USEO_LOGIN_USERNAME`
- `USEO_LOGIN_PASSWORD`

## Security and local-only files

Do **not** commit:
- real auth config files
- `.env` files
- real client report folders
- saved sitemap XML exports from private sites
- tokens or secret headers

The repo ignores the common risky local files already.

## Optional Lighthouse-style output

Use `--lighthouse` to request extra performance output. In v0.8.0 this produces `seo-lighthouse.csv` with lightweight browser-rendered timing proxies and render-blocking hints.

```bash
node scripts/run-seo-audit.mjs \
  --site https://www.example.com \
  --lighthouse
```
