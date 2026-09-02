# pi-lens v0.2.1 — security hardening

A hardening release focused on safely previewing untrusted files. No new
features, no breaking changes — recommended for all users.

## 🔒 Security fixes

- **Terminal control-character sanitization.** File contents (and filenames)
  are now stripped of C0/C1/DEL control bytes before rendering, so a malicious
  file can no longer smuggle terminal escape sequences into the drawer — e.g.
  window-title/clipboard (OSC) tricks, screen rewrites, or cursor moves.
  pi-lens's own styling escapes (syntax highlighting, gutters, page markers)
  are applied after sanitization and are unaffected.

- **Decompression-bomb protection.** The dependency-free PDF text extractor now
  caps zlib inflation via `maxOutputLength`. A few-hundred-KB stream can inflate
  to hundreds of MB; the cap stops such "zip bombs" from exhausting memory
  (verified: a 500 MB payload is now rejected in ~2 ms instead of allocating a
  524 MB buffer).

- **PDF parser resource cleanup.** pdf.js page usage is wrapped in
  `try/finally` with `page.cleanup()`, the loading task is destroyed on failure
  instead of leaking its worker/buffers, and a new internal `disposePdf()`
  releases the cached document when the drawer closes.

## Upgrade

```bash
pi install npm:@iamps6/pi-lens        # picks up 0.2.1
# or
npm i @iamps6/pi-lens@0.2.1
```

## Credits

Thanks to **Venkat** for the security review that prompted these fixes.

**Full changelog:** https://github.com/iamps6/pi-lens/compare/v0.2.0...v0.2.1
