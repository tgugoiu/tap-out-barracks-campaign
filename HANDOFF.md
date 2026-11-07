# Handoff: digital edition, v1 (2026-11-07)

## What was built

- **Reader** (`src/`, Vite + TypeScript + StPageFlip 2.0.7 in HTML mode). Features:
  - The cover opens alone and centred, then facing spreads follow, and the back cover stands alone, matching print parity.
  - Animated turns with corner dragging, hard covers and spine shading.
  - Page-edge stacks whose thickness follows reading progress.
  - Phones get single-page portrait reading, a spread in landscape, and rotation handling.
  - Controls: keyboard, swipe and tap.
  - A dock that fades out while reading: folio, previous/next, contact sheet, single/double toggle, detail zoom, copy link, PDF download and full screen.
  - A bottom scrubber with thumbnail previews.
  - `#page=N` deep links with history-aware Back/Forward.
  - A resume prompt (local storage only), a one-time corner-lift hint and a cover reveal.
  - A non-animated reader for reduced motion (also `?reader=simple`, and as the fallback if StPageFlip fails).
  - A retry state for pages that fail to load.
  - Open Graph preview, a home-screen icon, and a 404 page that redirects to the book.
- **Pipeline** (`pipeline/build_publication.py`):
  - Takes any PDF. Each page is rendered whole at 1.5× and Lanczos-reduced to 1800 px on the long edge, as WebP q90.
  - Also writes 420 px thumbnails, inline 24 px placeholders, the manifest, the OG image and the icon.
  - Optionally copies the PDF byte for byte.
  - Writes into a staging folder and swaps it in, so no orphaned pages survive.
- **Validator** (`scripts/validate-publication.mjs`): checks files, sizes, WebP dimensions, orphans, PDF hash, and GitHub's file size limits. It also runs in CI.
- **Release** (`npm run release -- final.pdf`): pages, validate, typecheck and build in one command.
- **Deployment** (`.github/workflows/deploy.yml`): checkout v7, setup-node v7, configure-pages v6, upload-pages-artifact v5, deploy-pages v5. Every push to `main` deploys.
- **QA** (`qa/run-qa.mjs` for Edge/Playwright with 51 checks; `qa/firefox.mjs` for stock Firefox over BiDi with 15 checks). Screenshots go to `qa-out/shots/`.

## Published edition

- Source: `sites/silent-campaign/dist/print/tap-out-barracks-the-silent-campaign.pdf`, as of 09:11 on 2026-11-07. 56 pages at 603×783 pt, 49.5 MB, SHA-256 `4e0eae54…1c22a`.
- I read it from a snapshot. The other thread's files were not modified.
- Output: 56 pages, 20.4 MB in total (365 KB on average, largest is p29 at 721 KB), thumbnails 1.33 MB, OG image 68 KB, PDF 49.5 MB (bundled).

## Measurements

Local `vite preview` of the production build, headless Edge 156, empty cache.

| Case | Result |
| --- | --- |
| First visit, 1440×900 @1×, emulated 10 Mbit/s / 70 ms | Cover shown at **663 ms** with **305 KB** transferred (cover 260 KB; JS 23 KB, CSS 4 KB and manifest 15 KB, all gzipped). No other page is requested until the cover has loaded. |
| …after 5 s idle | 1.60 MB: pages 1–5 (cover plus the next two spreads), no thumbnails. |
| Phone 390×844 @3×, after 5 s | 0.73 MB: pages 1–3. |
| Contact sheet opened | Desktop: 56 thumbnails (1.33 MB), because nearly every row is within range at that size. Phone: 27 thumbnails (0.60 MB). |
| At rest on a spread, 5 s window | Idle-redraw patch: 53–61 ms main-thread task time and 58 style recalcs. Library default (`?idle=raw`): 110–132 ms and 300 recalcs. |
| Bundle | JS 85 KB (23.5 KB gzipped), CSS 16 KB (4.4 KB gzipped). No fonts and no external requests. |

These timings come from headless runs and are not hardware GPU numbers. GitHub Pages
serves JS, CSS and JSON gzipped (as the local preview did); WebP is served as is.

## Findings about StPageFlip

- `loadFromImages` (canvas mode) creates an `Image` for every page in its constructor, so all 56 pages download at start. HTML mode with the reader's own loader avoids that. Every frame, the library sets `display:none` on hidden pages and restyles them, so native `loading="lazy"` cannot be relied on inside the book.
- The render loop restyles all pages on every frame even when nothing moves. `drawFrame` is wrapped so it runs only while a page moves.
- `destroy()` never stops that requestAnimationFrame loop. The reader therefore never re-creates the book: orientation is forced by changing `minWidth` on the live settings object.
- `flipToPage()` rewrites the spread index before animating. A jump started mid-turn landed on the wrong spread, so the reader now finishes any running turn first; the QA suite covers this.

## Known issues and limits

- StPageFlip 2.0.7 is unmaintained (2020). The reader relies on a few of its internals (`drawFrame`, `isUserTouch`, the live settings object); its version is pinned by `package-lock.json`.
- The full-screen button is hidden where the API is missing (iPhone Safari).
- Phones were tested as emulated Android Chrome and as Firefox at phone size. Real iOS Safari and Android hardware have not been tested.
- After a corner *drag* opens the cover, the book slides to centre once the turn lands. Clicked and keyboard turns slide during the turn.
- An odd page count pairs the last page instead of showing a standalone back cover. The pipeline and the validator warn about it.
- Each edition with a bundled PDF adds about 70 MB to Git history. Use `download.mode: "external"` to keep the PDF out of the repository.
- Social networks cache link previews. After changing the cover, re-scrape it with their debugger tools.

## When a new final PDF arrives

```bash
npm run release -- "E:/BoxVRMods/sites/silent-campaign/dist/print/tap-out-barracks-the-silent-campaign.pdf"
npm run preview
git add -A public/magazine && git commit -m "Publish edition <date>" && git push
```

## Local environment notes (this machine)

- Node is not on PATH: use `C:/Users/Theo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`.
- npm was fetched separately; any normal Node install works the same.
- Browser QA uses that runtime's Playwright through `PLAYWRIGHT_MODULE=…/node_modules/playwright/index.mjs` and installed Edge.
- Browser pane servers `tob-edition-dev` (5180) and `tob-edition-preview` (4180) were added to `E:/BoxVRMods/.claude/launch.json`.
- `incoming/` (ignored) holds read-only snapshots of the draft and final PDFs.
