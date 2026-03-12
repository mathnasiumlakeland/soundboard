# Soundboard

Static GitHub Pages site for `soundboard.mathnasium.pro`.

## Local preview

Use Bun to serve the static `site/` directory locally:

```bash
bun run dev
```

Then open `http://localhost:4173`.

The script runs `bunx serve site -l 4173 -n` under the hood.

## Site files

- `site/index.html`: main soundboard page
- `site/assets/styles.css`: styles
- `site/assets/app.js`: playback and cache logic
- `.github/workflows/deploy-pages.yml`: Pages deployment workflow
