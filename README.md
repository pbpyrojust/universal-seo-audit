# Universal SEO Audit (Phase 1 MVP)

A technical SEO audit CLI for development, staging, protected, and noindex sites.

## Phase 1 scope

Phase 1 checks:

- HTTP status codes
- title tags
- meta descriptions
- robots meta (`noindex` / `nofollow`)
- canonical tags
- H1 presence/count
- basic word count
- duplicate title detection

Outputs:

- `seo-pages.csv`
- `seo-issues.csv`
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

## Password-protected, staging, and development sites

The tool supports:

### 1. HTTP / Basic Auth

```bash
node scripts/run-seo-audit.mjs \
  --site https://staging.example.com \
  --http-username your-user \
  --http-password your-pass
```

### 2. Form login via local auth config

```bash
node scripts/run-seo-audit.mjs \
  --site https://staging.example.com \
  --auth-config ./auth.local.json
```

Example `auth.local.json`:

```json
{
  "loginUrl": "https://staging.example.com/login",
  "username": "your-username",
  "password": "your-password",
  "usernameSelector": "input[name='username']",
  "passwordSelector": "input[name='password']",
  "submitSelector": "button[type='submit']",
  "readySelector": "body",
  "postLoginWaitMs": 2000
}
```

The project ignores local auth files such as:

- `*.auth.json`
- `auth.local.json`
- `.auth.local.json`
- `.useo-auth.local.json`

Use the committed `auth-config.example.json` only as a template.

## Output

Each run writes to a site-name + timestamp folder, for example:

```text
reports/
  example.com-20260416-141010/
    urls.txt
    seo-pages.csv
    seo-issues.csv
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

## CLI wrapper

```bash
npm run cli -- audit --site https://www.example.com
```
