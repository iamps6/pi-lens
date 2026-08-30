# AGENTS.md — pi-lens

Context for AI agents (and humans) working on this repo.

## What this is

**pi-lens** is a [pi](https://pi.dev) extension that previews files inside the
pi TUI — markdown, source code, images, and PDFs — in a tabbed side **drawer**,
without leaving the terminal. Zero system dependencies.

## Layout

```
index.ts            # entry for pi auto-discovery (~/.pi/agent/extensions/<dir>/index.ts)
                    #   → re-exports default from ./src/index.ts
src/index.ts        # the whole extension (single file)
samples/            # demo files for manual testing
package.json        # name, pi.extensions (for `pi install`), devDeps for typecheck
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
- **PDF** — `extractPdfText()` is dependency-free (node:zlib FlateDecode). It only
  reads text inside `BT…ET` text objects and runs `isMostlyPrintable()` to avoid
  emitting image/binary garbage. Scanned PDFs → empty → "no text layer" message.
- **Images** — cannot render inside the overlay. The active image is drawn as a
  `belowEditor` widget (`ui.setWidget`) using pi's `Image` component — the same
  linear-flow path pi uses for tool images. `refreshImageWidget()` keeps it in
  sync with the active tab and clears it on close.

## Gotchas / hard constraints

- **Images in overlays corrupt the layout.** pi's `Image` uses cursor-movement
  escapes that only work in the main linear flow. Never put `Image` inside the
  overlay; use the belowEditor widget path.
- **Overlay width** is driven by `overlayOptions.width`; the resolver reads it
  every frame, so mutate `overlayOpts.width` + `requestRender()` to resize live.
  The width passed to `render()` is the source of truth for `cols`.
- **No split/reserve API** — the drawer overlay visually covers the right part of
  the transcript while open. This is a pi limitation; `sideshow` mode minimizes it.
- **Safety caps** (see constants): 8 MB parse limit, 400k text chars, 8000 render
  lines, 2 MB per inflate — these prevent freezes on large/complex files. Keep them.
- **Zero system deps** is a design goal. Rich/rasterized PDF pages would need an
  external rasterizer (e.g. macOS `sips`, `pdftoppm`, `mutool`) — treat as an
  optional, detected enhancement, never a hard dependency.

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

- Optional rasterized PDF pages (via detected `sips`/`pdftoppm`/`mutool`) shown
  through the belowEditor image path, with page navigation.
- Terminal-capability detection / graceful fallback.
- CSV/TSV table rendering.
- Upstream request: a real split/reserve-column API in pi so the drawer can dock
  beside the transcript instead of overlaying it.
