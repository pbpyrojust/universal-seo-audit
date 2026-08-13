# Publishing Guide

This repo is configured so you can:

1. keep it as a normal public GitHub repo
2. publish it as a public npm CLI package
3. optionally publish it to GitHub Packages later
4. automate npm publishing from GitHub Actions on version tags

## Package details

- **npm package:** `@pbpyrojust/universal-seo-audit`
- **CLI commands:** `universal-seo-audit`, `seoaudit`, `useoaudit`
- **Current version:** see `package.json`

## Before you publish

### 1. Confirm the public repo

Your repository should be:

```text
https://github.com/pbpyrojust/universal-seo-audit
```

### 2. Verify package metadata

Make sure these fields are correct in `package.json`:

- `name`
- `version`
- `description`
- `repository`
- `homepage`
- `bugs`
- `license`

### 3. Install dependencies

```bash
npm install
npx playwright install --with-deps chromium
```

### 4. Run a package check

```bash
npm pack --dry-run
```

That lets you verify exactly what will be published.

### 5. Make sure no secrets are present

Do **not** publish:

- `.npmrc` with a real token
- `.env` files
- generated reports
- client sitemap XML exports
- internal/staging URLs
- auth config files with real credentials

## First publish to npmjs.org

Log in locally:

```bash
npm login
```

Make sure the npm account is allowed to publish. npm requires one of these before direct publishing:

- two-factor authentication enabled on your npm account
- a granular access token with **Bypass 2FA** enabled

For an interactive first publish, the simplest path is to enable 2FA on npmjs.com, then publish from the terminal. npm may prompt for a one-time password, or you can pass it directly:

```bash
npm publish --access public --otp 123456
```

Then publish the package manually once:

```bash
npm publish --access public
```

Because this is a scoped public package, `--access public` is required for the first public publish.

Local manual publishing does not generate npm provenance. Provenance is handled by GitHub Actions after Trusted Publishing is configured.

## Set up automatic npm publishing from GitHub Actions

Create a workflow that publishes to npmjs.org on tags like:

```text
v1.5.0
```

### Recommended: npm trusted publishing

After the first manual publish, configure **Trusted Publisher** for this package on npmjs.com so GitHub Actions can publish without a long-lived npm token.

On npm package settings:

1. open the package page
2. go to package settings
3. add a **Trusted Publisher**
4. choose **GitHub Actions**
5. connect the repository:
   - `pbpyrojust/universal-seo-audit`

After that, future publishes can happen from GitHub Actions on version tags.

## Release flow for npmjs.org

### 1. Bump the version

Edit `package.json` or use npm's version command:

```bash
npm version patch --no-git-tag-version
```

### 2. Commit and push main

```bash
git add .
git commit -m "Prepare npm package release"
git push origin main
```

### 3. Push a version tag

Use the version from `package.json`:

```bash
VERSION="$(node -p "require('./package.json').version")"
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

The npm publish workflow can run automatically from that tag.

## Optional: publish to GitHub Packages later

GitHub Packages registry:

```text
https://npm.pkg.github.com
```

GitHub Packages has a few extra rules:

- npm packages published there must be scoped, such as `@pbpyrojust/universal-seo-audit`
- local publishing requires a classic GitHub personal access token
- GitHub Actions can publish with `GITHUB_TOKEN` when the package is associated with this repository
- first-published GitHub Packages may default to private visibility, so confirm the package visibility after the first publish if you want it public

### Trigger it with a tag

```bash
VERSION="$(node -p "require('./package.json').version")"
git tag "ghpkg-v${VERSION}"
git push origin "ghpkg-v${VERSION}"
```

## Install commands users will use

### From npmjs.org

```bash
npm install -g @pbpyrojust/universal-seo-audit
npx playwright install --with-deps chromium
universal-seo-audit quick --site https://www.example.com
universal-seo-audit audit --site https://www.example.com
```

### From source

```bash
git clone https://github.com/pbpyrojust/universal-seo-audit.git
cd universal-seo-audit
npm install
npx playwright install --with-deps chromium
node bin/universal-seo-audit.mjs quick --site https://www.example.com
node bin/universal-seo-audit.mjs audit --site https://www.example.com
```

## Recommended first sequence

Run these in order:

```bash
npm login
npm install
npx playwright install --with-deps chromium
npm pack --dry-run
npm publish --access public
git add .
git commit -m "Prepare npm CLI package for release"
git push origin main
VERSION="$(node -p "require('./package.json').version")"
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

After the first manual publish, switch to Trusted Publishing for future automated npm releases.

## Public repo checklist

Before each public release:

```bash
git status
npm pack --dry-run
```
