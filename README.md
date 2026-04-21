# frc-schedule-builder

A single-page tool for visualizing how FRC qualification match schedules fit into the available time blocks at a regional or district event. Fetches event data from [The Blue Alliance](https://thebluealliance.com) and parses the official FIRST agenda PDF to extract match windows automatically.

## Development

### Prerequisites

- Node.js 18+

### Install dependencies

```
npm install
```

### Run locally

Serve the source files over HTTP (required because `index.html` uses an ES-module import):

```
npm run dev
```

Then open `http://localhost:3000` in your browser.

### Build

The build step inlines `agenda-parser.mjs` into `index.html`, producing `dist/index.html` — a fully self-contained file with no local imports that works when opened directly from the filesystem or served over HTTP.

```
npm run build
```

Open `dist/index.html` directly in a browser, or serve with any static file server.

### Test

Runs the PDF parsing test suite against all 2026 FRC regional, district, and championship division events via the TBA API. Requires internet access and takes a few minutes.

```
npm test
```

## Deployment

Pushes to `main` automatically:
- Run the PDF parsing test suite
- Build and deploy to GitHub Pages (only if tests pass)

Pull requests run the tests only — no deploy.

Pushes to `main` automatically build and deploy to GitHub Pages via the workflow in `.github/workflows/deploy.yml`.

To enable GitHub Pages for this repo:
1. Go to **Settings → Pages**
2. Set **Source** to **GitHub Actions**

## Project structure

| File | Purpose |
|---|---|
| `index.html` | Source for the web app; uses `import` from `agenda-parser.mjs` |
| `agenda-parser.mjs` | Shared PDF parsing logic (used by `index.html` via build, and by the test script directly) |
| `build.mjs` | Build script — inlines the parser into `dist/index.html` |
| `test-agenda.mjs` | Test suite — validates PDF parsing across all 2026 events |
