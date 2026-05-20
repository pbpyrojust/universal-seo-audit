# Universal SEO Audit

**Version:** 1.4.2

Universal SEO Audit is a technical SEO and asset integrity audit CLI for development, staging, protected, and noindex sites.

## What this tool is for

- pre-launch SEO QA
- staging-site audits behind auth
- technical SEO backlog generation
- metadata/schema/canonical/Open Graph validation
- canonical and hreflang validation, including missing/duplicate canonical tags and missing/invalid/duplicate hreflang tags
- asset integrity validation across images, JS, CSS, fonts, and root files
- staging/production and `www` / non-`www` asset mismatch detection
- client-facing branded HTML/PDF reports

## Branded visual reports

The project now supports custom-branded visual reports.

Create a branding config from `branding.example.json`, then run:

```bash
node scripts/run-seo-audit.mjs --site https://www.example.com --brand-config ./branding.json
```

This generates:
- `seo-dashboard.html`
- `seo-dashboard.pdf`

## Example branding config

```json
{
  "companyName": "JustWhat.net",
  "logo": "./assets/logo.png",
  "primaryColor": "#0ea5e9",
  "secondaryColor": "#111827",
  "accentColor": "#22c55e",
  "reportTitle": "Technical SEO & Site Health Audit",
  "author": "Justin Adams",
  "footerText": "Confidential — Prepared by JustWhat.net"
}
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

## Canonical and hreflang checks

The audit now reports canonical and hreflang coverage directly in `seo-pages.csv` and `seo-issues.csv`.

It checks for:

- missing canonical tags
- duplicate canonical tags
- canonical URL mismatch
- cross-domain canonical targets
- missing hreflang tags
- invalid hreflang entries
- duplicate hreflang values

Note: missing hreflang is reported as low severity because many single-language sites do not need hreflang.

## Main commands

```bash
node scripts/run-seo-audit.mjs --site https://www.example.com
node scripts/run-seo-audit.mjs --site https://www.example.com --lighthouse
node scripts/run-seo-audit.mjs --site https://www.example.com --brand-config ./branding.json
```


## v1.4.2 bugfix

- Fixes Lighthouse runner compatibility with current `chrome-launcher` ESM exports by using a namespace import instead of a default import.
