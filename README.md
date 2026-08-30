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
- **Images** — rendered below the editor via your terminal's image protocol (iTerm2, Kitty, Ghostty, WezTerm, Warp); details shown in the drawer tab
- **Code / text** — scrollable viewer
- **Code** — syntax-highlighted with line numbers (`.ts` `.js` `.html` `.css` `.py` and many more)
- **PDF** — dependency-free text extraction (readable, searchable; detects scanned/image PDFs)
- **Tabbed side drawer** — open multiple files; switch between them as tabs
- **Adjustable width** — Regular (50%) · Focus (70%) · Sideshow (30%)
- **Stays open while you chat** — toggle focus in/out with a shortcut
- **Zero system dependencies** — pure Node/TypeScript

## Install

```bash
pi install git:github.com/iamps6/pi-lens
```

Or clone for local development:

```bash
git clone https://github.com/iamps6/pi-lens
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

## Limitations

- **Images** render **below the editor**, not inside the drawer box. pi's image
  protocol reserves vertical space with cursor-movement escapes that only work in
  the main linear flow; inside a floating overlay they corrupt the layout. So the
  drawer tab shows image details while the picture itself draws below the editor.
- **Scanned/image-only PDFs** have no text layer, so text extraction returns
  nothing (OCR is out of scope for a zero-dependency extension).
- The drawer is an **overlay**, so it visually covers the right portion of the
  transcript while open. pi has no split/reserve-column API for extensions.
  Use `/lens-mode sideshow` to minimize coverage, or `/lens-close` when done.

## License

MIT © Srikanth
