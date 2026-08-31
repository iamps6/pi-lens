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
  truecolor terminal), plus a hi-res companion below the editor via your
  terminal's image protocol (iTerm2, Kitty, Ghostty, WezTerm, Warp)
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
terminal. A **hi-res companion** of the active visual also renders below the
editor using the native image protocol where supported.

## Limitations

- Quadrant resolution is 2·drawer-width × 2·rows pixels — great for photos,
  charts, and page layout; fine print on dense PDF pages is best read in text
  view (`v` toggles).
- **Scanned/image-only PDFs** have no text layer; use visual mode (`v`) to view
  them (OCR is out of scope).
- Without the optional `@napi-rs/canvas`, visual modes are unavailable — images
  show an info card and PDFs are text-only. Without `pdfjs-dist`, PDF falls back
  to a basic built-in extractor.
- The drawer is an **overlay**, so it visually covers the right portion of the
  transcript while open. pi has no split/reserve-column API for extensions.
  Use `/lens-mode sideshow` to minimize coverage, or `/lens-close` when done.

## License

MIT © Srikanth
