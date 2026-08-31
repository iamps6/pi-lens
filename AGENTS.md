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
src/pixels.ts       # media engine: quadrant renderer, image decode, pdf.js text + page rasters
samples/            # local-only test fixtures (gitignored, not shipped)
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
  `src/pixels.ts`. Quadrant blocks are plain styled text → they work *inside* the
  overlay drawer (scroll/tabs/borders), unlike pi's `Image` component (see
  gotchas). Rendering is async: `contentLines()` returns "rendering…" and calls
  `hooks.requestVisual(tab, innerW)`, which caches `tab.pixels` per width+page
  and calls `refresh()` when done.
- **PDF** — text view uses `extractPdfTextRich()` (pdf.js `getTextContent`, handles
  encodings/CMaps); falls back to the legacy zero-dep `extractPdfText()` (zlib
  `BT…ET` scan) when pdfjs-dist is missing. Visual view (`v`) renders ALL pages
  progressively into one continuous scrollable strip (quadrant blocks, 2x2 px
  per cell); `n`/`p` jump between pages via pageOffsets; last doc cached in pixels.ts.
- **Peek (`enter`/`o`)** — opens the file in the OS previewer via `qlmanage -p`
  (macOS Quick Look) / `xdg-open` / `start`. This is the pixel-perfect view.
  All in-terminal native-image attempts (overlay, belowEditor widget, fullscreen
  custom component) corrupted pi's layout — do not reintroduce pi's `Image`
  component anywhere in this extension without live-verifying first.
- **Feature detection** — `hasCanvas()`/`hasPdfjs()` lazy-import once; every visual
  path degrades gracefully (image → info card; pdf → text-only).

## Gotchas / hard constraints

- **Native raster protocols do not work on ANY extension surface.** User-verified
  facts (iTerm2): pi's own transcript images render crisp (protocol + terminal
  are fine), but pi's `Image` component corrupts layout in all three extension
  surfaces we tried — drawer overlay, belowEditor widget, and fullscreen
  `ui.custom` component. Root cause: OSC 1337/Kitty draw rasters at the cursor in
  a linear append-only flow, while extension surfaces are *composited* (partial
  line rewrites at arbitrary positions each frame) — cursor-move escapes land
  wrong and partial updates slice the raster. Do not reintroduce `Image` anywhere
  in this extension. Crisp viewing = OS peek (`enter`). Known future paths to
  crisp-in-chat: (a) upstream pi API to append rich content to the transcript or
  an image-safe overlay region; (b) register a tool whose result includes image
  content — pi core renders tool-result images in the transcript (crisp), at the
  cost of putting the image into LLM context (tokens + privacy; make it opt-in,
  e.g. a `/lens-send` command).
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
/lens README.md              # markdown + scroll
/lens src/index.ts           # syntax highlighting
/lens <some .pdf>            # extracted text; v = visual pages; enter = peek
/lens <some .png>            # quadrant thumbnail; enter = peek
/lens-mode focus             # resize
```

The `samples/` dir is gitignored — create local fixtures there freely; they
will not ship.

Type-check (after `npm install`): `npm run typecheck`.

## Roadmap

- Terminal-capability detection (truecolor check for quadrant blocks; fall back to
  256-color quantization).
- CSV/TSV table rendering.
- Zoom for visual mode (render at 2x cols and pan horizontally).
- Opt-in `/lens-send`: push the current visual into the chat as a tool-result
  image → crisp in-transcript rendering (enters LLM context; document cost).
- Upstream requests to pi: (1) split/reserve-column API so the drawer can dock
  instead of overlaying; (2) extension API for appending rich (image) content to
  the transcript, which would enable crisp in-chat viewing without Quick Look.
