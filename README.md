# Universal SEO Audit (Phase 3)

A technical SEO audit CLI for development, staging, protected, and noindex sites.

This project is designed to solve a gap that tools like SEMrush often have on dev/staging environments: it can audit pages even when they are password protected or intentionally set to `noindex`, while still giving you structured, ticket-ready technical SEO findings.

## What this project is for

Use this tool when you need to audit websites that:

- are still in development
- are on staging/password-protected environments
- use `noindex, nofollow`
- are blocked from normal external crawler tools
- still need technical SEO review before launch

## Phase coverage

### Phase 1
- HTTP status codes
- title tags
- meta descriptions
- robots meta (`noindex` / `nofollow`)
- canonical tags
- H1 presence/count
- basic word-count/content presence

### Phase 2
- broken internal/external link validation
- duplicate title clustering
- duplicate meta description clustering
- image alt SEO checks
- thin-content flags
- image inventory output

### Phase 3
- html `lang` checks
- viewport meta checks
- JSON-LD/structured data parsing checks
- `X-Robots-Tag` header noindex checks
- hreflang validation basics
- lightweight render diagnostics:
  - DOM node count
  - resource count
  - script tag count
  - stylesheet count

## Main outputs

- `seo-pages.csv`
- `seo-issues.csv`
- `seo-images.csv`
- `seo-structured-data.csv`
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

### Standard audit
```bash
node scripts/run-seo-audit.mjs --site https://www.example.com
```

### Include all sitemaps
```bash
node scripts/run-seo-audit.mjs \
  --site https://www.example.com \
  --include-all-sitemaps
```

### Protected site with basic auth
```bash
node scripts/run-seo-audit.mjs \
  --site https://staging.example.com \
  --http-username your-user \
  --http-password your-pass
```

### Protected site with form-login config
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

### Raw scan only from a prepared URL list
```bash
node scripts/seo-audit.mjs \
  --urls-file ./reports/urls.txt \
  --out-dir ./reports \
  --run-id example.com-20260416-141010
```

## Supported flags and common use cases

### Crawl/source control
- `--site <url>`: base site URL
- `--sitemap-url <url>`: force a specific sitemap
- `--include-all-sitemaps`: include taxonomy/user/archive sitemaps too
- `--include-sitemaps "page,post"`: only include matching sitemap names
- `--urls-file <path>`: scan from a prepared URL list
- `--batch-size <n>`: limit the run to the first N URLs

### Protected/staging environments
- `--http-username`
- `--http-password`
- `--auth-config ./auth.local.json`
- `--login-url`
- `--username`
- `--password`
- `--username-selector`
- `--password-selector`
- `--submit-selector`
- `--ready-selector`
- `--post-login-wait-ms`

### Conservative/protected-site pacing
- `--slow`
- `--respect-robots`
- `--cloudflare-aware`
- `--crawl-delay-ms <ms>`
- `--backoff-ms <ms>`
- `--retries <n>`

### Link validation
- `--max-link-checks <n>`: cap the number of unique links checked in phase 2/3

## Auth config example

Use the committed `auth-config.example.json` as a template:

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

## Output

Each run writes to a site-name + timestamp folder, for example:

```text
reports/
  example.com-20260416-141010/
    urls.txt
    seo-pages.csv
    seo-issues.csv
    seo-images.csv
    seo-structured-data.csv
    seo-summary-google-doc.md
    seo-ticket-backlog.csv
    seo-report.json
```

### What the files are for

- `seo-pages.csv`: one row per page with key technical/on-page signals
- `seo-issues.csv`: one row per issue for triage and filtering
- `seo-images.csv`: image alt/title inventory
- `seo-structured-data.csv`: structured data / hreflang / lang / viewport / page-weight signals
- `seo-summary-google-doc.md`: docs-ready summary for stakeholders
- `seo-ticket-backlog.csv`: one row per ticket/work item

## Long-running scans, warnings, and progress indicators

The tool prints:

- large-scan warnings
- protected-site warnings
- ETA remaining per page
- heartbeat lines for slow navigation or extraction steps
- link validation progress

Example:

```text
[3/25] Scanning: https://example.com/page | ETA remaining: 7.5m
   … still working on https://example.com/page (SEO extraction) | elapsed 22.1s | ETA remaining: 6.3m
   ↳ Link checks completed: 50/180
```

## CLI wrapper

You can also use the wrapper command:

```bash
npm run cli -- audit --site https://www.example.com
```

Or later, after packaging:

```bash
universal-seo-audit audit --site https://www.example.com
```

## Security and local-only files

Do **not** commit real auth files or secrets.

Ignored by default:

- `*.auth.json`
- `auth.local.json`
- `.auth.local.json`
- `.useo-auth.local.json`
- `.env`
- `.env.*`
- `.npmrc`
- report output folders
- browser-saved sitemap XML files

## What Phase 3 is supposed to catch

Before launch, this version is meant to help you answer questions like:

- Are there missing or duplicate titles and meta descriptions?
- Are canonicals missing, duplicated, or pointing somewhere wrong?
- Are there broken internal links that need to be fixed before launch?
- Are pages accidentally carrying `noindex` via meta or `X-Robots-Tag` headers?
- Are pages missing `lang` or viewport tags?
- Is structured data present and valid?
- Are hreflang tags malformed?
- Are some pages becoming heavy enough to be worth simplifying before launch?

## Suggested next Phase 4 ideas

- full duplicate-content clustering by body similarity
- sitemap vs crawl diff/orphan-page detection
- structured data type validation rules
- render-blocking asset heuristics
- optional Lighthouse/PageSpeed integration
- internal link depth analysis
- canonical chain/redirect chain analysis
