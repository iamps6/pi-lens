# pi-lens

> In-terminal file previews for [pi](https://pi.dev) — never leave your session to read a file.

Preview markdown, images, code, and PDFs right inside your pi session, in a
scrollable **overlay** or a persistent **side drawer** that stays open while you
keep chatting. Zero system dependencies.

## Why

pi is a great terminal AI harness, but reading files means switching back to an
editor. `pi-lens` closes that gap: a single command pops a readable preview
without leaving the terminal.

## Features

- **Markdown** — rendered with headings, tables, and syntax-highlighted code
- **Code** — syntax-highlighted with line numbers (`.ts` `.js` `.html` `.css` `.py` and many more)
- **PDF** — full text extraction via pdf.js, **plus visual page mode** (`v`): pages
  render as one continuous scrollable strip *inside the drawer* (`n`/`p` jump pages)
- **Images** — rendered as pixels **inside the drawer** (ANSI half-blocks, any
  truecolor terminal) for quick reference; press `enter` for a pixel-perfect Quick Look peek
- **Tabbed side drawer** — open multiple files; switch between them as tabs
- **Adjustable width** — Regular (50%) · Focus (70%) · Sideshow (30%)
- **Stays open while you chat** — toggle focus in/out with a shortcut
- **No system dependencies** — everything installs from npm (`pdfjs-dist` pure JS;
  `@napi-rs/canvas` optional, prebuilt binaries). Degrades gracefully if absent

## Install

```bash
pi install git:github.com/iamps6/pi-lens
```

Or clone for local development:

```bash
git clone https://github.com/iamps6/pi-lens
cd pi-lens && npm install     # installs pdfjs-dist + optional @napi-rs/canvas
# then add the path to ~/.pi/settings.json under "extensions", or symlink into
# ~/.pi/agent/extensions/
```

## Usage

### Commands

| Command | Description |
|---|---|
| `/lens <path>` | Open a file in the drawer (opens/adds a tab). Accepts absolute, `~`, or relative paths |
| `/lens-mode [regular\|focus\|sideshow]` | Set drawer width (interactive picker if no arg) |
| `/lens-close` | Close the drawer |

### Global shortcut

| Key | Action |
|---|---|
| `ctrl+shift+l` | Toggle focus in/out of the drawer (scroll vs. chat) |

### In-drawer keys (when focused)

| Key | Action | Key | Action |
|---|---|---|---|
| `↑`/`↓` `j`/`k` | scroll | `←`/`→` `Tab` `[`/`]` | switch tabs |
| `space`/`pgdn` `pgup` | page | `1`..`9` | jump to tab |
| `g` / `G` | top / bottom | `w` | close current tab |
| `ctrl+shift+l` | back to chat | `q` | close drawer |
| `v` | PDF: toggle text/visual page view | `n` / `p` | PDF visual: next/prev page |
| `enter` / `o` | **peek**: open in the OS previewer — Quick Look on macOS (esc closes) | | |

Try it with the bundled samples:

```
/lens samples/sample.md
/lens samples/sample.pdf
/lens samples/dot.png
/lens-mode focus
```

## Supported formats

| Type | Extensions | Rendering |
|---|---|---|
| Markdown | `.md` `.markdown` `.mdx` | native markdown renderer |
| Image | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp` | native image protocol |
| PDF | `.pdf` | text extraction (FlateDecode + `Tj`/`TJ`) |
| Text/code | everything else | scrollable text |

## Roadmap

- [ ] `ctrl+o` focus toggle to scroll the persistent drawer
- [ ] Terminal-capability detection with graceful fallback
- [ ] Robust PDF via bundled pure-JS `pdfjs-dist` (still zero system deps)
- [ ] Optional rasterized PDF pages where a rasterizer is available
- [ ] CSV/TSV table rendering
- [ ] File picker when no path is given

## How visuals work

Images and PDF pages are converted to pixels and rendered as **ANSI quadrant-block
characters** (▘▝▞▛… with truecolor fg/bg = 2×2 pixels per cell, chafa-style) — plain styled text
that works inside the drawer with scrolling, tabs, and borders, in any truecolor
terminal. For pixel-perfect viewing, `enter` opens the file in the OS-native previewer
(Quick Look on macOS) — a floating panel over the terminal, `esc` closes it.

## Limitations

### Why aren't drawer visuals full-detail?

You may notice pi itself can show **crisp inline images** in the chat transcript
(e.g. when you attach an image or the `read` tool returns one) — so why are
pi-lens visuals blocky? Two different rendering worlds:

**1. The drawer is made of text.** The drawer is a floating overlay that pi's
TUI composites by rewriting styled *text lines* at column offsets every frame.
A text cell can show at most **2 colors** (foreground + background). Using
quadrant glyphs (`▘▝▞▛…`) we squeeze **2×2 "pixels" per cell** out of that —
the best possible encoding (same technique as chafa/timg). At a 70-cell drawer
width that's ~140 px of horizontal resolution with a 2-color-per-cell
constraint. That's an information-density ceiling of character-cell graphics,
not an implementation choice. No algorithm renders "full detail" in text cells.

**2. The crisp path is closed to extensions.** Terminals *can* draw real
pixel-perfect rasters (iTerm2 OSC 1337, Kitty graphics) — that's what pi uses
for transcript images. But those protocols draw at the cursor inside a **linear,
append-only flow**: emit sequence → terminal paints the raster → rows are
reserved via cursor movement. pi's transcript is exactly such a flow, so it
works there. The surfaces extensions can draw on — overlays and widgets — are
**composited**: lines are partially rewritten at arbitrary positions each frame.
A raster protocol inside a compositor fights for the same screen cells with no
z-order or damage-tracking contract: cursor math lands in the wrong place,
partial line updates slice through the image, and the layout corrupts. We tried
all three extension surfaces (overlay, below-editor widget, fullscreen custom
component) — all corrupt. There is currently **no pi extension API to append
rich content to the transcript**, which is the only crisp surface.

Hence the design: **drawer = navigate** (text is perfect, visuals are
thumbnails), **`enter` = look** (OS previewer, pixel-perfect, `esc` back).

### Other limitations

- **Scanned/image-only PDFs** have no text layer; use visual mode (`v`) or peek
  (`enter`) to view them (OCR is out of scope).
- Without the optional `@napi-rs/canvas`, visual modes are unavailable — images
  show an info card and PDFs are text-only. Without `pdfjs-dist`, PDF falls back
  to a basic built-in extractor.
- The drawer is an **overlay**, so it visually covers the right portion of the
  transcript while open. pi has no split/reserve-column API for extensions.
  Use `/lens-mode sideshow` to minimize coverage, or `/lens-close` when done.
- Quick Look peek is macOS; Linux/Windows fall back to the default app
  (`xdg-open`/`start`).

## License

MIT © Srikanth
