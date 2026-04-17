# Universal SEO Audit

**Version:** 0.6.0

Universal SEO Audit is a production-oriented technical SEO audit CLI for development, staging, protected, and noindex sites.

It is built for cases where external crawlers often fail or do not have enough access to be useful, including password-protected staging environments, development sites behind login, intentionally non-indexed sites, and browser-rendered sites that need pre-launch QA.

The tool renders pages in a real browser with Playwright, builds URL lists from sitemaps, supports protected-site authentication, and produces page-level CSVs, issue CSVs, technical analysis outputs, markdown summaries, and ticket-ready backlog files.

## What this tool is for

- pre-launch SEO QA
- staging-site audits behind auth
- technical SEO backlog generation for engineering/content teams
- metadata/schema/canonical/Open Graph validation before launch
- browser-rendered technical SEO crawling when external crawlers cannot see enough of the site

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

### Content and duplication analysis
- duplicate titles
- duplicate meta descriptions
- duplicate-content clustering by body similarity
- thin-content flags

### Structured data and international signals
- JSON-LD/schema presence
- JSON-LD parse validity
- schema type extraction
- html `lang`
- hreflang validity

### Social/share coverage
- `og:title`
- `og:description`
- `og:image`
- `og:url`

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
    seo-duplicates.csv
    seo-summary-google-doc.md
    seo-ticket-backlog.csv
    seo-report.json
    seo-run-metadata.json
```

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
- `--duplicate-threshold`
- `--max-redirect-hops`
- `--priority-model`
- `--no-duplicate-clustering`

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
