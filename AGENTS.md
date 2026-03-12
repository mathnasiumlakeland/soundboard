# Soundboard Agent Guide

## Overview
- This repo is a static GitHub Pages site. There is no app framework, bundler pipeline, or server runtime in the repo itself.
- The deploy workflow uploads the `site/` directory as-is from [`.github/workflows/deploy-pages.yml`](/Users/mkieffer/programming/mathnasium/soundboard/.github/workflows/deploy-pages.yml).
- Keep changes simple and browser-native unless the user explicitly asks for tooling or architecture changes.

## Local Workflow
- Start a preview server with `bun run dev`.
- The preview serves `site/` at `http://localhost:4173`.
- There is no automated test suite in the repo today.
- For a fast syntax/module sanity check after JS edits, run `bun build site/assets/app.js --outfile /tmp/soundboard-app.js`.
- Manual browser verification is the main validation path for UI, audio, countdown, password, caching, and haptics changes.

## File Map
- [`package.json`](/Users/mkieffer/programming/mathnasium/soundboard/package.json): only local dev script.
- [`site/index.html`](/Users/mkieffer/programming/mathnasium/soundboard/site/index.html): single-page shell, password modal, countdown overlay, audio element.
- [`site/404.html`](/Users/mkieffer/programming/mathnasium/soundboard/site/404.html): static fallback page.
- [`site/assets/app.js`](/Users/mkieffer/programming/mathnasium/soundboard/site/assets/app.js): all runtime behavior.
  - Renders buttons from `buttonData`.
  - Handles delegated pointer/click activation.
  - Manages audio playback, browser cache warmup, localStorage metadata, password flow, cooldowns, and the `67` countdown.
  - Owns haptic triggering and lifecycle cleanup.
- [`site/assets/buttons.js`](/Users/mkieffer/programming/mathnasium/soundboard/site/assets/buttons.js): source of truth for sound buttons.
  - Each entry needs `id`, `label`, `url`, and `color`.
  - Optional `password` locks a button behind the modal flow.
  - Buttons are sorted client-side by `label`, so array order is not final display order.
- [`site/assets/haptics.js`](/Users/mkieffer/programming/mathnasium/soundboard/site/assets/haptics.js): local haptics helper.
  - Preset-based (`success`, `error`, `buzz`).
  - Uses `navigator.vibrate` when supported.
  - Falls back to a hidden control technique for best-effort Safari/iPhone behavior.
- [`site/assets/styles.css`](/Users/mkieffer/programming/mathnasium/soundboard/site/assets/styles.css): all layout, sprite-based button visuals, modal styles, countdown animation, and 404 styling.

## Implementation Notes
- The app is intentionally centralized. Prefer extending `site/assets/app.js` over creating abstractions unless duplication becomes real.
- `stopCurrentPlayback()` is the main cleanup point. If a new feature has playback-like lifecycle, wire cleanup there and in the existing `audio ended` and `beforeunload` handlers.
- The `67` button is special:
  - It is identified by `COUNTDOWN_BUTTON_ID === "67"`.
  - It requires a password, runs the 3-2-1 countdown overlay, and can trigger looping haptics during playback.
- Password modal behavior matters:
  - Button cancel/submit paths are separate from backdrop/Escape dismissal.
  - Incorrect passwords start a cooldown stored in localStorage.
- Audio caching is browser-side only:
  - Cache API stores fetched audio responses.
  - localStorage tracks freshness timestamps and cooldown expirations.
  - If you change cache behavior, preserve graceful fallback when `caches` or storage are unavailable.

## Change Guidelines
- Keep the site deployable as plain static files under `site/`.
- Avoid adding npm dependencies or a build step unless explicitly requested.
- Reuse the existing DOM structure and delegated event model before adding per-button listeners.
- Preserve accessibility basics already present:
  - `aria-live` announcements.
  - Button `aria-label`s.
  - Modal semantics.
- When adding a new sound button, prefer editing only `site/assets/buttons.js` unless the interaction itself changes.
- When changing visuals, verify the sprite/button dimensions still line up with the existing PNG assets.

## Validation Checklist
- Preview locally with `bun run dev`.
- If JS changed, run `bun build site/assets/app.js --outfile /tmp/soundboard-app.js`.
- Manually test the affected flows in a browser.
- For button-flow changes, verify:
  - Regular buttons still play audio.
  - Password-protected buttons still respect accept/cancel/error behavior.
  - `67` countdown behavior still blocks background interaction correctly.
  - Haptics remain best-effort and fail silently on unsupported browsers.
