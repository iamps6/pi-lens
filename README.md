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
- **Images** — inline via your terminal's image protocol (iTerm2, Kitty, Ghostty, WezTerm, Warp)
- **Code / text** — scrollable viewer
- **PDF** — dependency-free text extraction (readable, searchable)
- **Overlay or side drawer** — modal preview, or a drawer that persists while you chat
- **Zero system dependencies** — pure Node/TypeScript

## Install

```bash
pi install git:github.com/<you>/pi-preview
```

Or clone for local development:

```bash
git clone https://github.com/<you>/pi-preview
# then add the path to ~/.pi/settings.json under "extensions", or symlink into
# ~/.pi/agent/extensions/
```

## Usage

| Command | Description |
|---|---|
| `/preview <path>` | Open a file in a scrollable overlay (modal) |
| `/drawer <path>` | Open a file in a persistent right-side drawer |
| `/drawer-close` | Close the drawer |

Inside the overlay: `↑/↓` scroll · `space`/`pgdn` page · `g`/`G` top/bottom · `esc`/`q` close.

Try it with the bundled samples:

```
/preview samples/sample.md
/preview samples/dot.png
/preview samples/sample.pdf
/drawer  samples/sample.md
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

## License

MIT © Srikanth
