# Xaventra website

The website is deliberately static and dependency-free. Open `index.html`
locally or serve this directory with any HTTP server.

```bash
npx serve website
```

GitHub Pages deployment is defined in `.github/workflows/pages.yml`. The
workflow assembles the shared icon into the published artifact so the website
and Desktop app use one canonical asset.

