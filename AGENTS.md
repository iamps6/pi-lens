# AGENTS.md — pi-lens

Context for AI agents (and humans) working on this repo.

## What this is

**pi-lens** is a [pi](https://pi.dev) extension that previews files inside the
pi TUI — markdown, source code, images, and PDFs (text + visual pages) — in a
tabbed side **drawer**, without leaving the terminal. npm deps only, no system
installs: `pdfjs-dist` (pure JS) + optional `@napi-rs/canvas` (prebuilt native).

## Layout

```
index.ts            # entry for pi auto-discovery (~/.pi/agent/extensions/<dir>/index.ts)
                    #   → re-exports default from ./src/index.ts
src/index.ts        # extension: commands, drawer UI, tabs, loaders
src/pixels.ts       # media engine: half-block renderer, image decode, pdf.js text + page rasters
samples/            # demo files for manual testing
package.json        # name, pi.extensions, deps (pdfjs-dist; optional @napi-rs/canvas)
```

`index.ts` exists because pi auto-discovery loads `<dir>/index.ts`, while
`package.json`'s `pi.extensions` points at `src/index.ts` for `pi install`.
Keep both in sync.

## Commands & keys

- `/lens [path]` — open a file as a tab (no path = welcome screen). Accepts
  absolute, `~`, and cwd-relative paths.
- `/lens-mode [regular|focus|sideshow]` — drawer width 50% / 70% / 30%.
- `/lens-close` — close the drawer.
- `ctrl+shift+l` — global shortcut to toggle focus in/out of the drawer.
- In-drawer (focused): `↑/↓ j/k` scroll · `space/pgdn pgup` page · `g/G` top/bottom
  · `←/→ Tab [ ]` switch tabs · `1..9` jump · `w` close tab · `q` quit.

## Architecture (src/index.ts)

- **classify()/load()** — detect kind (`image|markdown|code|pdf|text`) and load
  content. Uses pi's `getLanguageFromPath` for code, `getImageDimensions` for
  images.
- **DrawerViewer** — a TUI component rendered as a right-anchored overlay
  (`ctx.ui.custom({ overlay: true })`). Draws a bordered panel: header tab bar
  (`pi-lens ┃ 1·a.md │ 2·b.ts`), scrollable body, footer with hints + scroll %.
  Width comes from `overlayOptions.width` (a live `%` string), NOT from the
  component — see gotchas.
- **Tabs** — module-level `tabs[]` + `active`; opening the same path re-focuses
  its tab. State lives in the extension closure; `DrawerViewer` reads it via
  `hooks`.
- **Code highlighting** — `highlightSource()` uses pi's `highlightCode()` and
  adds line-number gutter + soft wrap.
- **Visuals (the key architecture)** — images & PDF pages are converted to pixels
  and rendered as **ANSI quadrant blocks** (▘▝▞▛… truecolor fg/bg, 2×2 px per cell) in
  `src/pixels.ts`. Half-blocks are plain styled text → they work *inside* the
  overlay drawer (scroll/tabs/borders), unlike pi's `Image` component (see
  gotchas). Rendering is async: `contentLines()` returns "rendering…" and calls
  `hooks.requestVisual(tab, innerW)`, which caches `tab.pixels` per width+page
  and calls `refresh()` when done.
- **PDF** — text view uses `extractPdfTextRich()` (pdf.js `getTextContent`, handles
  encodings/CMaps); falls back to the legacy zero-dep `extractPdfText()` (zlib
  `BT…ET` scan) when pdfjs-dist is missing. Visual view (`v`) renders ALL pages
  progressively into one continuous scrollable strip (quadrant blocks, 2x2 px
  per cell); `n`/`p` jump between pages via pageOffsets; last doc cached in pixels.ts.
- **FullViewer** — `enter`/`o` on a visual tab opens a fullscreen pixel-perfect
  viewer: a NON-overlay `ui.custom` component (main linear flow), where pi's
  `Image` component + native protocol render at full resolution. The drawer
  overlay is `setHidden(true)` while open so it does not cover the image.
- **Hi-res companion** — the active visual (image file or rendered PDF page PNG)
  is also drawn `belowEditor` via `ui.setWidget` + pi's `Image` component (native
  protocol, readable fine print). `refreshHifiWidget()` syncs it; cleared on close.
- **Feature detection** — `hasCanvas()`/`hasPdfjs()` lazy-import once; every visual
  path degrades gracefully (image → info card; pdf → text-only).

## Gotchas / hard constraints

- **Never put pi's `Image` component inside the overlay.** It uses cursor-movement
  escapes that only work in the main linear flow; in a floating overlay they
  corrupt the layout ("window inside a window"). In-drawer visuals must be
  half-blocks (plain text); native-protocol images only via the belowEditor widget.
- **pdfjs-dist import**: use `pdfjs-dist/legacy/build/pdf.mjs` via dynamic import,
  and set `globalThis.DOMMatrix/Path2D/ImageData` from @napi-rs/canvas *before*
  importing it. `page.render({ canvasContext, viewport, canvas })` needs the
  canvas object in pdf.js v5+.
- **Overlay width** is driven by `overlayOptions.width`; the resolver reads it
  every frame, so mutate `overlayOpts.width` + `requestRender()` to resize live.
  The width passed to `render()` is the source of truth for `cols`.
- **No split/reserve API** — the drawer overlay visually covers the right part of
  the transcript while open. This is a pi limitation; `sideshow` mode minimizes it.
- **Safety caps** (see constants): 8 MB parse limit, 400k text chars, 8000 render
  lines, 2 MB per inflate — these prevent freezes on large/complex files. Keep them.
- **npm-only deps** is the design line: `dependencies` must install everywhere
  (`pdfjs-dist` is pure JS); anything with native binaries goes in
  `optionalDependencies` (`@napi-rs/canvas` has prebuilds) and must be
  feature-detected at runtime. No system installs (`brew`, `apt`) ever required.

## Testing

Load-check without launching the TUI (resolves the `@earendil-works/*` imports
the way pi does):

```bash
D=/usr/local/lib/node_modules/@earendil-works/pi-coding-agent
mkdir -p "$D/examples/extensions/_t" && cp index.ts "$D/examples/extensions/_t/" && cp -r src "$D/examples/extensions/_t/"
node -e "const m=require('jiti')('$D')('$D/examples/extensions/_t/index.ts'); console.log('OK', typeof (m.default||m));"
rm -rf "$D/examples/extensions/_t"
```

Manual test in a pi session (symlink the repo into pi's extensions dir, or use
`pi -e ./src/index.ts`):

```
/reload
/lens samples/sample.md      # scroll
/lens samples/sample.ts      # syntax highlighting
/lens samples/dot.png        # image below editor
/lens samples/sample.pdf     # extracted text
/lens-mode focus             # resize
```

Type-check (after `npm install`): `npm run typecheck`.

## Roadmap

- Terminal-capability detection (truecolor check for half-blocks; fall back to
  256-color quantization).
- CSV/TSV table rendering.
- Zoom for visual mode (render at 2x cols and pan horizontally).
- Upstream request: a real split/reserve-column API in pi so the drawer can dock
  beside the transcript instead of overlaying it.
