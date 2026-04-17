# Universal SEO Audit (Phase 2)

A technical SEO audit CLI for development, staging, protected, and noindex sites.

This project is designed to solve a gap that tools like SEMrush often have on dev/staging environments: it can audit pages even when they are password protected or intentionally set to `noindex`.

## Phase 1 + Phase 2 scope

Core checks:
- HTTP status codes
- title tags
- meta descriptions
- robots meta (`noindex` / `nofollow`)
- canonical tags
- H1 presence/count
- basic word-count/content presence

Phase 2 additions:
- broken internal/external link validation
- duplicate title clustering
- duplicate meta description clustering
- image alt SEO checks
- thin-content flags
- image inventory output

Outputs:
- `seo-pages.csv`
- `seo-issues.csv`
- `seo-images.csv`
- `seo-summary-google-doc.md`
- `seo-ticket-backlog.csv`
- `seo-report.json`

## Requirements

- Node.js 20+
- npm
- Playwright Chromium

Install:

```bash
npm install
npx playwright install --with-deps chromium
```

## Quick start

Standard audit:

```bash
node scripts/run-seo-audit.mjs --site https://www.example.com
```

Protected site with basic auth:

```bash
node scripts/run-seo-audit.mjs \
  --site https://staging.example.com \
  --http-username your-user \
  --http-password your-pass
```

Protected site with form-login config:

```bash
node scripts/run-seo-audit.mjs \
  --site https://staging.example.com \
  --auth-config ./auth.local.json
```

Small-batch protected-site test:

```bash
node scripts/run-seo-audit.mjs \
  --site https://staging.example.com \
  --auth-config ./auth.local.json \
  --slow \
  --respect-robots \
  --cloudflare-aware \
  --batch-size 10
```

## Output

Each run writes to a site-name + timestamp folder, for example:

```text
reports/
  example.com-20260416-141010/
    urls.txt
    seo-pages.csv
    seo-issues.csv
    seo-images.csv
    seo-summary-google-doc.md
    seo-ticket-backlog.csv
    seo-report.json
```

## Long-running scans, warnings, and progress indicators

The tool prints:
- large-scan warnings
- protected-site warnings
- ETA remaining per page
- heartbeat lines for slow navigation or extraction steps

Example:

```text
[3/25] Scanning: https://example.com/page | ETA remaining: 7.5m
   … still working on https://example.com/page (SEO extraction) | elapsed 22.1s | ETA remaining: 6.3m
```
