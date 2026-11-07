# TAP OUT BARRACKS — The Silent Campaign · digital edition

A page-turning web edition of the print magazine, published free on GitHub Pages at
**https://tgugoiu.github.io/tap-out-barracks-campaign/**.

Each page of the finished PDF is rendered whole into a web image, and the
reader turns them like a magazine. Spreads, the cover and the back cover follow
the print parity: page 1 alone, then facing pairs, and the last page alone.
Nothing is cropped, rearranged or captioned.

## Commands

Node 20.19+ (tested on 24) and Python 3.9+ with `pip install -r pipeline/requirements.txt`.

| What | Command |
| --- | --- |
| Install | `npm ci` |
| Local development (http://127.0.0.1:5180/) | `npm run dev` |
| Regenerate pages from a PDF | `npm run pages -- path/to/magazine.pdf` |
| Check the generated pages | `npm run validate` |
| Production build (into `dist/`, Pages base path) | `npm run build` |
| Serve the build exactly as Pages will (http://127.0.0.1:4180/tap-out-barracks-campaign/) | `npm run preview` |
| **All of the above for a new edition** | `npm run release -- path/to/final.pdf` |
| Browser QA (Edge via Playwright, see `qa/run-qa.mjs`) | `npm run build && npm run qa` |
| Firefox QA (stock Firefox over WebDriver BiDi) | `node qa/firefox.mjs` |

## Publishing a new edition

1. `npm run release -- "path/to/final.pdf"`. This renders the pages, validates
   them against the PDF, type-checks and builds. It replaces `public/magazine/`
   as a unit, so no pages from the previous edition survive.
2. `npm run preview` and leaf through it.
3. `git add -A public/magazine && git commit -m "Publish edition …" && git push`.
4. The **Deploy to GitHub Pages** workflow builds and deploys in about two
   minutes (Actions tab).

The HTML, page list and styles never need editing. The reader is driven by
`public/magazine/manifest.json`, so any page count or page size works. An
odd page count makes the last page share a spread, and the pipeline warns
about it.

### The PDF download

`pipeline.includePdf` in `site.config.json` (default `true`) copies the PDF,
byte for byte, to `public/magazine/download/`. Each published edition then adds
its PDF to the Git history (about 50 MB now; GitHub warns above 50 MB and
refuses files above 100 MB). To host the PDF elsewhere, for example on Google Drive:

```json
"download": { "mode": "external", "externalUrl": "https://…", "label": "Download the PDF" },
"pipeline": { "includePdf": false }
```

`"mode": "none"` hides the download button. Draft PDFs belong in `incoming/`, which Git ignores.

## One-time GitHub setup

Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The workflow (`.github/workflows/deploy.yml`) runs on every push to `main` and
can also be started by hand from the Actions tab. Asset URLs follow the Pages
base path automatically, including after a repository rename or with a custom
domain. `siteUrl` in `site.config.json` is only used for link previews
(Open Graph); update it if the address changes.

## Configuration (`site.config.json`)

- `title`, `subtitle`, `description`, `siteUrl`, `themeColor`: branding and link previews.
- `download`: see above.
- `reader`:
  - `defaultView`: `auto`, `single` or `double`.
  - `flipTimeMs`: duration of a page turn.
  - `coverDensity`: `hard` gives stiff covers; `soft` makes them turn like the inner pages.
  - `preloadSpreadsAhead` / `preloadSpreadsBehind`: how many spreads to prefetch.
  - `maxLoadedPages`: the memory cap; phones use at most 16.
  - `concurrentRequests`, `controlsAutoHideMs`, `cornerHint`, `resumePrompt`.
  - `gutterShadow`: spine shading, 0–0.6.
  - `pageStack`: shows the page-edge thickness.
- `pipeline`:
  - `pageLongEdge`: default 1800 px.
  - `pageQuality`: WebP quality, default 90. Lower values smear photo grain in the shadows.
  - `thumbLongEdge` / `thumbQuality`.
  - `supersample`: renders at 1.5× and then reduces.
  - `includePdf`, `pdfFileName`.

## Reading controls

- Arrow keys, Page Up/Down and Space turn pages; Home and End jump to the covers.
- Drag a page corner, or click a page, to turn it.
- `T` opens the contact sheet of all spreads, `Z` the zoomable detail view, and `F` toggles full screen.
- Esc closes overlays.
- Phones: swipe, tap an edge to turn, tap the middle to show or hide the controls, and use two fingers for the detail view.
- Links: `#page=24` opens the spread that contains page 24, and the share button copies the current page's link.
- With *prefers-reduced-motion*, or `?reader=simple`, a non-animated reader is used.
- The reader remembers the last page per browser (local storage only) and offers to resume.
- There is no analytics, tracking, web fonts or external requests.

## Layout

```
index.html, src/           reader (TypeScript, Vite); src/renderers/flip.ts wraps StPageFlip
public/magazine/           GENERATED publication: manifest, pages, thumbs, previews, PDF
pipeline/                  PDF → pages (Python, PyMuPDF + Pillow)
scripts/                   pages / validate / release commands
qa/                        browser QA (writes qa-out/, ignored)
.github/workflows/         Pages deployment
HANDOFF.md                 what was built, measurements, known issues
```
