# Soundboard

Static GitHub Pages site for `soundboard.mathnasium.pro`.

## Publish

1. Push this repository to GitHub.
2. In the repository settings, go to `Pages`.
3. Set `Source` to `GitHub Actions`.
4. Under `Custom domain`, enter `soundboard.mathnasium.pro`.
5. Keep the Namecheap DNS record:
   - `CNAME`
   - `Host`: `soundboard`
   - `Target`: `mathnasiumlakeland.github.io`

## Site files

- `site/index.html`: main soundboard page
- `site/assets/styles.css`: styles
- `site/assets/app.js`: playback and cache logic
- `.github/workflows/deploy-pages.yml`: Pages deployment workflow
