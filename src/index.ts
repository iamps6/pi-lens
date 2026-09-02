/**
 * pi-lens — in-terminal file previews for pi
 *
 * Commands:
 *   /lens <path>     Open a file in the pi-lens side drawer (opens/adds a tab)
 *   /lens-mode       Set drawer width: regular (50%) · focus (70%) · sideshow (30%)
 *   /lens-close      Close the drawer
 *
 * Global shortcut:
 *   ctrl+shift+l     Toggle focus in/out of the drawer (scroll vs. chat)
 *
 * In-drawer keys (when focused):
 *   ↑/↓ j/k          scroll        space/pgdn · pgup    page
 *   g / G            top / bottom  ← / → (or Tab)       switch tabs
 *   1..9             jump to tab   w                    close current tab
 *   enter / o        peek in OS previewer (Quick Look)  q  close drawer
 *   v                PDF text ⇄ visual pages            n/p next/prev page
 *   ctrl+shift+l     back to chat
 *
 * Deps (npm-only, graceful degradation): pdfjs-dist for PDF text + page rasters;
 * optional @napi-rs/canvas for visuals. Fallback PDF extractor uses node:zlib.
 */

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { inflateSync, inflateRawSync } from "node:zlib";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import { disposePdf, extractPdfTextRich, hasCanvas, MAX_VISUAL_PAGES, renderImageCells, renderPdfPages } from "./pixels.ts";
import {
	getImageDimensions,
	Key,
	Markdown,
	matchesKey,
	type OverlayHandle,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

// ── Safety limits (prevent freezes on large/complex files) ──────────────────
const MAX_PARSE_BYTES = 8 * 1024 * 1024; // don't parse files larger than this
const MAX_TEXT_CHARS = 400_000; // cap extracted/loaded text
const MAX_LINES = 8000; // cap rendered content lines
const MAX_INFLATE_CHARS = 2_000_000; // cap per-stream decoded size

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};
const MD_EXT = new Set([".md", ".markdown", ".mdx"]);

type Kind = "image" | "markdown" | "text" | "pdf" | "code";

function classify(path: string): Kind {
	const ext = extname(path).toLowerCase();
	if (ext in IMAGE_MIME) return "image";
	if (MD_EXT.has(ext)) return "markdown";
	if (ext === ".pdf") return "pdf";
	if (getLanguageFromPath(path)) return "code";
	return "text";
}

/** Resolve a user path: strip quotes, ~ expansion, absolute as-is, else vs cwd. */
function expandPath(p: string, cwd: string): string {
	let s = p.trim().replace(/^['"]|['"]$/g, "");
	if (s === "~") s = homedir();
	else if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
	return isAbsolute(s) ? s : resolve(cwd, s);
}

/**
 * Strip terminal control characters from untrusted file content so a malicious
 * file can't smuggle its own escape sequences (cursor moves, screen rewrites,
 * window-title / clipboard / OSC tricks) into the drawer when we render it.
 * Keep \t and \n; drop the rest of C0, DEL, and the C1 range. Styling escapes
 * that pi-lens adds itself (highlighter, gutters, page markers) are applied
 * AFTER this, so they are unaffected.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
function sanitizeText(s: string): string {
	return s.replace(CONTROL_CHARS, "");
}

function capText(s: string): string {
	const clean = sanitizeText(s);
	return clean.length > MAX_TEXT_CHARS
		? clean.slice(0, MAX_TEXT_CHARS) + "\n\n… (truncated — file too large to preview fully)"
		: clean;
}

// ── Dependency-free PDF text extraction ─────────────────────────────────────
function extractPdfText(buf: Buffer): string {
	const out: string[] = [];
	let total = 0;
	let i = 0;
	let streams = 0;
	const needle = Buffer.from("stream");
	const endNeedle = Buffer.from("endstream");
	while (i < buf.length && streams < 5000 && total < MAX_TEXT_CHARS) {
		const s = buf.indexOf(needle, i);
		if (s === -1) break;
		let dataStart = s + needle.length;
		if (buf[dataStart] === 0x0d) dataStart++;
		if (buf[dataStart] === 0x0a) dataStart++;
		const e = buf.indexOf(endNeedle, dataStart);
		if (e === -1) break;
		const chunk = buf.subarray(dataStart, e);
		i = e + endNeedle.length;
		streams++;

		let text: string | undefined;
		for (const fn of [inflateSync, inflateRawSync]) {
			try {
				// Cap output DURING decompression — a few-KB stream can otherwise
				// inflate to gigabytes (a "zip bomb") and exhaust memory before we
				// ever get a chance to slice it. maxOutputLength throws past the cap.
				const dec = fn(chunk, { maxOutputLength: MAX_INFLATE_CHARS });
				text = dec.subarray(0, MAX_INFLATE_CHARS).toString("latin1");
				break;
			} catch {
				/* not this codec */
			}
		}
		if (text === undefined && chunk.length < 1_000_000) {
			const raw = chunk.toString("latin1");
			if (raw.includes("BT") && /\)\s*Tj|\]\s*TJ/.test(raw)) text = raw;
		}
		// Only real content streams: must contain text objects (BT..ET). This skips
		// image/font/pixel streams, which otherwise decode to binary garbage.
		if (text && text.includes("BT") && /\bT[jJ]\b|\)Tj|\]TJ/.test(text)) {
			const piece = extractTextObjects(text);
			if (piece.trim()) {
				out.push(piece);
				total += piece.length;
			}
		}
	}
	const joined = out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
	return isMostlyPrintable(joined) ? joined : "";
}

/** Extract text only from within BT..ET text objects (ignores image/binary data). */
function extractTextObjects(s: string): string {
	let res = "";
	const bt = /BT([\s\S]*?)ET/g;
	let b: RegExpExecArray | null;
	while ((b = bt.exec(s)) && res.length < MAX_TEXT_CHARS) {
		res += decodeContentStreamText(b[1]!) + "\n";
	}
	return res;
}

function decodeContentStreamText(s: string): string {
	let res = "";
	const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[dD*]\b/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) && res.length < MAX_TEXT_CHARS) {
		const tok = m[0];
		if (tok.startsWith("(")) res += unescapePdfString(tok.slice(1, -1));
		else if (tok.startsWith("<")) res += hexToStr(tok.slice(1, -1));
		else if (tok === "Td" || tok === "TD" || tok === "T*") res += "\n";
	}
	return res;
}

/** Guard against decoding image/binary as text: require mostly printable output. */
function isMostlyPrintable(s: string): boolean {
	if (!s) return false;
	const sample = s.slice(0, 4000);
	let printable = 0;
	for (let i = 0; i < sample.length; i++) {
		const c = sample.charCodeAt(i);
		if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160) printable++;
	}
	return printable / sample.length > 0.85;
}

function unescapePdfString(s: string): string {
	return s
		.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
		.replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\")
		.replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}
function hexToStr(h: string): string {
	const clean = h.replace(/\s+/g, "");
	let out = "";
	for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
	return out;
}

// ── Loading ─────────────────────────────────────────────────────────────────
interface Loaded {
	title: string;
	kind: Kind;
	content: string;
	lang?: string;
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1048576).toFixed(1)} MB`;
}

async function load(path: string): Promise<{ data: Loaded; pageCount: number; startVisual: boolean }> {
	// Filenames are attacker-controllable too (they appear in tab labels and the
	// image card), so strip control characters from the title as well.
	const title = sanitizeText(basename(path));
	const kind = classify(path);
	const size = statSync(path).size;

	if (kind === "image") {
		const buf = readFileSync(path);
		const mime = IMAGE_MIME[extname(path).toLowerCase()]!;
		const dim = getImageDimensions(buf.toString("base64"), mime);
		const card = [
			`# 🖼  ${title}`,
			"",
			`- **Type:**  ${mime}`,
			`- **Dimensions:**  ${dim ? `${dim.widthPx} × ${dim.heightPx} px` : "unknown"}`,
			`- **Size:**  ${fmtBytes(buf.length)}`,
			"",
			"_Install optional dependency @napi-rs/canvas to see the image inline._",
		].join("\n");
		const visual = await hasCanvas();
		return {
			data: { title, kind: "image", content: card },
			pageCount: 0,
			startVisual: visual,
		};
	}
	if (size > MAX_PARSE_BYTES) {
		return { data: { title: `${title} · too large`, kind: "text", content: `File is ${(size / 1048576).toFixed(1)} MB — too large to preview safely.` }, pageCount: 0, startVisual: false };
	}
	if (kind === "pdf") {
		// Proper extraction via pdf.js; fall back to the zero-dep zlib extractor.
		try {
			const rich = await extractPdfTextRich(path);
			if (rich) {
				return { data: { title, kind: "pdf", content: capText(rich.text) }, pageCount: rich.pageCount, startVisual: false };
			}
		} catch { /* fall through */ }
		let text = "";
		try {
			text = extractPdfText(readFileSync(path));
		} catch (e) {
			text = `(failed to extract PDF text: ${(e as Error).message})`;
		}
		return { data: { title: `${title} · text`, kind: "pdf", content: capText(text || "(no extractable text — install pdfjs-dist for full extraction)") }, pageCount: 0, startVisual: false };
	}
	if (kind === "code") {
		return { data: { title, kind, content: capText(readFileSync(path, "utf8")), lang: getLanguageFromPath(path) }, pageCount: 0, startVisual: false };
	}
	return { data: { title, kind, content: capText(readFileSync(path, "utf8")) }, pageCount: 0, startVisual: false };
}

// ── Drawer state ─────────────────────────────────────────────────────────────
interface Tab {
	path: string;
	data: Loaded;
	scroll: number;
	/** "text" = markdown/extracted text; "visual" = quadrant-block pixel view */
	view: "text" | "visual";
	page: number;
	pageCount: number;
	pixels?: { lines: string[]; forWidth: number; pageOffsets?: number[] };
	visualGen?: number;
	visualError?: string;
}

type Mode = "regular" | "focus" | "sideshow";
const MODE_PCT: Record<Mode, `${number}%`> = { regular: "50%", focus: "70%", sideshow: "30%" };
const MODE_LABEL: Record<Mode, string> = { regular: "Regular (50%)", focus: "Focus (70%)", sideshow: "Sideshow (30%)" };

interface DrawerHooks {
	tabs: () => Tab[];
	active: () => number;
	setActive: (i: number) => void;
	closeActiveTab: () => void;
	closeAll: () => void;
	backToChat: () => void;
	refresh: () => void;
	isFocused: () => boolean;
	/** Kick an async pixel render for a visual tab (image / pdf pages). */
	requestVisual: (tab: Tab, innerW: number) => void;
	toggleView: (tab: Tab) => void;
	/** Jump one page forward/back in a PDF visual strip. */
	pageJump: (tab: Tab, dir: 1 | -1) => void;
	/** Open the file in the OS-native previewer (Quick Look on macOS). */
	openPeek: (tab: Tab) => void;
}

/** Derive the current page from scroll position within a visual strip. */
function pageFromScroll(tab: Tab): number {
	const offs = tab.pixels?.pageOffsets;
	if (!offs || !offs.length) return 1;
	let page = 1;
	for (let i = 0; i < offs.length; i++) if (tab.scroll >= (offs[i] ?? 0)) page = i + 1;
	return page;
}

const BRAND = "pi-lens";

class DrawerViewer {
	private cache: string[] | null = null;
	private cacheKey = "";

	constructor(private theme: Theme, private h: DrawerHooks) {}

	/** Panel height (rows). Width is supplied by the overlay via render(width). */
	private rowsAvail() {
		return Math.max(8, (process.stdout.rows || 40) - 4);
	}

	private contentLines(tab: Tab, innerW: number, contentRows: number): string[] {
		const data = tab.data;

		// Visual view: quadrant-block pixels rendered asynchronously, cached per tab.
		if (tab.view === "visual") {
			if (tab.visualError) {
				return [this.theme.fg("error", tab.visualError), "", this.theme.fg("dim", "press v for text view")];
			}
			if (tab.pixels && tab.pixels.forWidth === innerW) {
				return tab.pixels.lines;
			}
			this.h.requestVisual(tab, innerW);
			return [this.theme.fg("dim", tab.pageCount ? `rendering ${tab.pageCount} pages…` : "rendering…")];
		}

		const key = `${data.title}|${data.kind}|${innerW}x${contentRows}`;
		if (this.cache && this.cacheKey === key) return this.cache;
		let lines: string[];
		try {
			if (data.kind === "markdown" || data.kind === "image") {
				lines = new Markdown(data.content, 0, 0, getMarkdownTheme()).render(innerW);
			} else if (data.kind === "code") {
				lines = highlightSource(data.content, data.lang, innerW);
			} else {
				lines = data.content.split("\n").flatMap((l) => wrap(l, innerW));
			}
		} catch (e) {
			lines = [this.theme.fg("error", `render error: ${(e as Error).message}`)];
		}
		if (lines.length > MAX_LINES) {
			lines = lines.slice(0, MAX_LINES);
			lines.push(this.theme.fg("dim", "… (truncated)"));
		}
		this.cache = lines;
		this.cacheKey = key;
		return lines;
	}

	render(width: number): string[] {
		const t = this.theme;
		const focused = this.h.isFocused();
		const cols = Math.max(20, width);
		const rows = this.rowsAvail();
		const innerW = Math.max(8, cols - 4);
		const contentRows = rows - 2;
		const border = (s: string) => t.fg(focused ? "borderAccent" : "borderMuted", s);

		const tabs = this.h.tabs();
		const active = this.h.active();
		const tab = tabs[active];
		if (!tab) return [border("┌" + "─".repeat(cols - 2) + "┐"), border("│") + " no file ".padEnd(cols - 2) + border("│"), border("└" + "─".repeat(cols - 2) + "┘")];

		const all = this.contentLines(tab, innerW, contentRows);
		const maxScroll = Math.max(0, all.length - contentRows);
		if (tab.scroll > maxScroll) tab.scroll = maxScroll;
		if (tab.scroll < 0) tab.scroll = 0;

		// Header: ┌─ pi-lens ┃ tab1 │ tab2 ───────────┐
		const brandStyled = t.fg("accent", t.bold(BRAND));
		const tabBudget = Math.max(4, cols - 3 - BRAND.length - 3 - 2);
		const { text: tabbar, width: tabW } = buildTabBar(tabs, active, tabBudget, t);
		const usedLeft = 3 + BRAND.length + 3 + tabW + 1; // "┌─ " + brand + " ┃ " + tabs + " "
		const dashN = Math.max(0, cols - usedLeft - 1); // trailing "┐"
		const header = border("┌─ ") + brandStyled + border(" ┃ ") + tabbar + border(" " + "─".repeat(dashN) + "┐");

		// Body
		const view = all.slice(tab.scroll, tab.scroll + contentRows);
		const body: string[] = [];
		for (let r = 0; r < contentRows; r++) {
			const line = view[r] ?? "";
			body.push(border("│ ") + line + " ".repeat(Math.max(0, innerW - visibleWidth(line))) + border(" │"));
		}

		// Footer: └─ hints ────[ 42% ]┘
		const pct = all.length <= contentRows ? 100 : Math.round((tab.scroll / maxScroll) * 100);
		const isPdf = tab.data.kind === "pdf" && tab.pageCount > 0;
		const right = tab.view === "visual" && isPdf ? `pg ${pageFromScroll(tab)}/${tab.pageCount}` : `${pct}%`;
		const hintsFull = focused
			? isPdf
				? tab.view === "visual"
					? "↵ peek · n/p pages · v text · ↑↓ scroll · q quit"
					: "↵ peek · v visual · ↑↓ scroll · w close · q quit"
				: tab.view === "visual"
					? "↵ peek · ←→ tabs · w close · q quit"
					: "↵ peek · ↑↓ scroll · ←→ tabs · w close · ctrl+shift+l chat · q quit"
			: "ctrl+shift+l to focus";
		const hints = truncate(hintsFull, Math.max(0, cols - 7 - right.length - 4));
		const fdash = Math.max(0, cols - 3 - visibleWidth(hints) - 1 - 1 - right.length - 2);
		const footer = border("└─ ") + t.fg("dim", hints) + border(" " + "─".repeat(fdash) + " ") + t.fg("dim", right) + border(" ┘");

		return [clamp(header, cols), ...body.map((l) => clamp(l, cols)), clamp(footer, cols)];
	}

	invalidate(): void {
		this.cache = null;
		this.cacheKey = "";
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.rowsAvail() - 3);
		const tabs = this.h.tabs();
		const active = this.h.active();
		const tab = tabs[active];
		if (!tab) return;

		if (matchesKey(data, Key.ctrlShift("l"))) return this.h.backToChat();
		if (data === "q") return this.h.closeAll();
		if (data === "w") return this.h.closeActiveTab();

		// tab switching
		if (matchesKey(data, "right") || matchesKey(data, "tab") || data === "]") return this.h.setActive((active + 1) % tabs.length);
		if (matchesKey(data, "left") || matchesKey(data, "shift+tab") || data === "[") return this.h.setActive((active - 1 + tabs.length) % tabs.length);
		if (/^[1-9]$/.test(data)) {
			const idx = parseInt(data, 10) - 1;
			if (idx < tabs.length) this.h.setActive(idx);
			return;
		}

		// PDF: v toggles text/visual; n/p page nav in visual view
		if (data === "v" && tab.data.kind === "pdf" && tab.pageCount > 0) return this.h.toggleView(tab);
		if (tab.data.kind === "pdf" && tab.view === "visual") {
			if (data === "n") return this.h.pageJump(tab, 1);
			if (data === "p") return this.h.pageJump(tab, -1);
		}
		// OS-native peek (Quick Look on macOS) — works for any real file
		if ((matchesKey(data, "enter") || data === "o") && tab.path !== WELCOME_PATH) return this.h.openPeek(tab);

		if (matchesKey(data, "up") || data === "k") tab.scroll -= 1;
		else if (matchesKey(data, "down") || data === "j") tab.scroll += 1;
		else if (data === " " || matchesKey(data, "pageDown")) tab.scroll += page;
		else if (matchesKey(data, "pageUp")) tab.scroll -= page;
		else if (data === "g") tab.scroll = 0;
		else if (data === "G") tab.scroll = Number.MAX_SAFE_INTEGER;
		else return;
		this.invalidate();
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────
function buildTabBar(tabs: Tab[], active: number, budget: number, t: Theme): { text: string; width: number } {
	const labels = tabs.map((tab, i) => truncate(`${i + 1}·${tab.data.title}`, 22));
	const w = labels.map((l) => visibleWidth(l));
	const sep = 3; // " │ "
	// choose a window [lo,hi] containing active that fits budget
	let lo = active, hi = active, used = w[active] ?? 0;
	for (;;) {
		let ext = false;
		if (hi + 1 < labels.length && used + sep + w[hi + 1] <= budget) { hi++; used += sep + w[hi]; ext = true; }
		if (lo - 1 >= 0 && used + sep + w[lo - 1] <= budget) { lo--; used += sep + w[lo]; ext = true; }
		if (!ext) break;
	}
	const parts: string[] = [];
	for (let i = lo; i <= hi; i++) {
		const styled = i === active ? t.fg("accent", t.bold(labels[i]!)) : t.fg("muted", labels[i]!);
		parts.push(styled);
	}
	let text = parts.join(t.fg("dim", " │ "));
	let width = used;
	if (lo > 0) { text = t.fg("dim", "‹ ") + text; width += 2; }
	if (hi < labels.length - 1) { text = text + t.fg("dim", " ›"); width += 2; }
	return { text, width };
}

/** Syntax-highlight source code (via pi's highlighter) and soft-wrap to width. */
function highlightSource(content: string, lang: string | undefined, width: number): string[] {
	let highlighted: string[];
	try {
		highlighted = highlightCode(content, lang);
	} catch {
		highlighted = content.split("\n");
	}
	const gutterW = String(highlighted.length).length;
	const out: string[] = [];
	for (let i = 0; i < highlighted.length; i++) {
		const num = String(i + 1).padStart(gutterW, " ");
		const gutter = `\x1b[2m${num}\x1b[22m `;
		const body = width - gutterW - 1;
		const parts = wrap(highlighted[i] ?? "", Math.max(4, body));
		out.push(gutter + (parts[0] ?? ""));
		for (let k = 1; k < parts.length; k++) out.push(" ".repeat(gutterW + 1) + parts[k]);
	}
	return out;
}

function wrap(line: string, width: number): string[] {
	if (visibleWidth(line) <= width) return [line];
	const out: string[] = [];
	let cur = "";
	for (const ch of line) {
		if (visibleWidth(cur + ch) > width) { out.push(cur); cur = ch; } else cur += ch;
	}
	out.push(cur);
	return out;
}

function truncate(s: string, max: number): string {
	if (max <= 0) return "";
	if (visibleWidth(s) <= max) return s;
	let out = "";
	for (const ch of s) { if (visibleWidth(out + ch) > max - 1) break; out += ch; }
	return out + "…";
}

/** Guard against wrapping: never let a framed line exceed the panel width. */
function clamp(line: string, cols: number): string {
	return visibleWidth(line) <= cols ? line : truncate(line, cols);
}

const WELCOME_PATH = "\u0000pi-lens-welcome";
const WELCOME = [
	"# pi-lens",
	"",
	"You are using **pi-lens** — a TUI previewer for most file types, right inside pi.",
	"Markdown · code (highlighted) · PDFs (text + visual pages) · images.",
	"",
	"## Commands",
	"- `/lens <path>` — open a file (adds a tab)",
	"- `/lens-mode` — width: Regular · Focus · Sideshow",
	"- `/lens-close` — close the drawer",
	"",
	"## Keys",
	"- `enter` — **peek**: open in the OS previewer (pixel-perfect; esc closes)",
	"- ↑ ↓ scroll · ← → tabs · `1..9` jump · `w` close tab · `q` quit",
	"- `v` — PDF: text ⇄ visual pages · `n`/`p` — next/prev page",
	"- `ctrl+shift+l` — focus in / out of the drawer (scroll vs. chat)",
	"",
	"---",
	"",
	"Built with ♥ by [iamps6](https://github.com/iamps6)",
].join("\n");
const welcomeTab = (): Tab => ({ path: WELCOME_PATH, data: { title: "welcome", kind: "markdown", content: WELCOME }, scroll: 0, view: "text", page: 1, pageCount: 0 });

// ── extension ─────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	const tabs: Tab[] = [];
	let active = 0;
	let mode: Mode = "regular";
	let handle: OverlayHandle | null = null;
	let tui: TUI | null = null;
	let viewer: DrawerViewer | null = null;
	const overlayOpts = { anchor: "right-center" as const, margin: 1, maxHeight: "100%" as const, width: MODE_PCT[mode] };

	const refresh = () => { viewer?.invalidate(); tui?.requestRender(); };
	const isFocused = () => !!handle?.isFocused();

	// OS-native previewer: pixel-perfect, instant, zero terminal-protocol pain.
	// macOS: Quick Look floating panel (esc closes). Linux/Windows: default app.
	const openPeek = (tab: Tab) => {
		try {
			if (process.platform === "darwin") spawn("qlmanage", ["-p", tab.path], { detached: true, stdio: "ignore" }).unref();
			else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", tab.path], { detached: true, stdio: "ignore" }).unref();
			else spawn("xdg-open", [tab.path], { detached: true, stdio: "ignore" }).unref();
		} catch { /* best effort */ }
	};

	// Async pixel renderer for visual tabs. Images render in one shot; PDFs
	// render page-by-page into one continuous scrollable strip (progressive).
	const visualJobs = new Set<string>();
	const requestVisual = (tab: Tab, innerW: number) => {
		const key = `${tab.path}@${innerW}`;
		if (visualJobs.has(key)) return;
		visualJobs.add(key);
		const gen = (tab.visualGen = (tab.visualGen ?? 0) + 1);
		void (async () => {
			try {
				if (tab.data.kind === "image") {
					const r = await renderImageCells(tab.path, innerW);
					if (tab.visualGen !== gen) return;
					if (r) tab.pixels = { lines: r.lines, forWidth: innerW };
					else { tab.visualError = "image decode unavailable (@napi-rs/canvas not installed)"; tab.view = "text"; }
				} else if (tab.data.kind === "pdf") {
					const lines: string[] = [];
					const offsets: number[] = [];
					const count = await renderPdfPages(tab.path, innerW, (pageLines, pageNum, pageCount) => {
						if (tab.visualGen !== gen) return;
						if (pageNum > 1) lines.push(`\x1b[2m── page ${pageNum}/${pageCount} ──\x1b[22m`);
						offsets.push(pageNum > 1 ? lines.length - 1 : 0);
						lines.push(...pageLines);
						tab.pixels = { lines: [...lines], forWidth: innerW, pageOffsets: [...offsets] };
						tab.pageCount = pageCount;
						refresh();
					});
					if (tab.visualGen !== gen) return;
					if (count === null) { tab.visualError = "page render unavailable (@napi-rs/canvas not installed)"; tab.view = "text"; }
					else if (count > MAX_VISUAL_PAGES) {
						lines.push(`\x1b[2m… ${count - MAX_VISUAL_PAGES} more pages (open in text view for all content)\x1b[22m`);
						tab.pixels = { lines: [...lines], forWidth: innerW, pageOffsets: [...offsets] };
					}
				}
			} catch (e) {
				tab.visualError = `render failed: ${(e as Error).message}`;
			} finally {
				visualJobs.delete(key);
				refresh();
			}
		})();
	};
	const toggleView = (tab: Tab) => {
		tab.view = tab.view === "visual" ? "text" : "visual";
		tab.visualError = undefined;
		tab.scroll = 0;
		refresh();
	};
	const pageJump = (tab: Tab, dir: 1 | -1) => {
		const offs = tab.pixels?.pageOffsets;
		if (!offs || !offs.length) return;
		const target = Math.min(Math.max(1, pageFromScroll(tab) + dir), offs.length);
		tab.scroll = offs[target - 1] ?? 0;
		tab.page = target;
		refresh();
	};

	const closeAll = () => {
		handle?.hide();
		handle = null; tui = null; viewer = null;
		tabs.length = 0; active = 0;
		// Release the cached pdf.js document (worker + buffers) on close.
		disposePdf();
	};
	const setActive = (i: number) => { active = i; refresh(); };
	const closeActiveTab = () => {
		if (!tabs.length) return;
		tabs.splice(active, 1);
		if (!tabs.length) return closeAll();
		if (active >= tabs.length) active = tabs.length - 1;
		refresh();
	};
	const backToChat = () => { handle?.unfocus(); refresh(); };

	const hooks: DrawerHooks = {
		tabs: () => tabs, active: () => active, setActive, closeActiveTab, closeAll, backToChat, refresh, isFocused,
		requestVisual, toggleView, pageJump, openPeek,
	};

	const ensureOpen = (ctx: ExtensionCommandContext) => {
		if (handle) { handle.focus(); refresh(); return; }
		overlayOpts.width = MODE_PCT[mode];
		void ctx.ui.custom<{ closed: true }>(
			(tuiArg, theme, _kb, _done) => {
				tui = tuiArg;
				viewer = new DrawerViewer(theme, hooks);
				return viewer;
			},
			{ overlay: true, overlayOptions: overlayOpts, onHandle: (h) => { handle = h; h.focus(); } },
		);
	};

	pi.registerCommand("lens", {
		description: "Preview a file in the pi-lens side drawer (any path; ~ & relative ok)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("/lens requires the TUI", "warning");
			const raw = args.trim();

			// No path → welcome screen (or focus the drawer if already open)
			if (!raw) {
				if (!tabs.length) { tabs.push(welcomeTab()); active = 0; }
				return ensureOpen(ctx);
			}

			const path = expandPath(raw, ctx.cwd);
			let loaded: Awaited<ReturnType<typeof load>>;
			try { loaded = await load(path); }
			catch (e) { return ctx.ui.notify(`Cannot open ${path}: ${(e as Error).message}`, "error"); }

			// Replace the welcome tab on first real open
			const wi = tabs.findIndex((tb) => tb.path === WELCOME_PATH);
			if (wi >= 0) tabs.splice(wi, 1);

			const existing = tabs.findIndex((tb) => tb.path === path);
			if (existing >= 0) {
				active = existing;
				const tb = tabs[existing]!;
				tb.data = loaded.data;
				tb.pageCount = loaded.pageCount || tb.pageCount;
			} else {
				tabs.push({
					path,
					data: loaded.data,
					scroll: 0,
					view: loaded.startVisual ? "visual" : "text",
					page: 1,
					pageCount: loaded.pageCount,
				});
				active = tabs.length - 1;
			}

			ensureOpen(ctx);
		},
	});

	pi.registerCommand("lens-mode", {
		description: "Set pi-lens drawer width (regular/focus/sideshow)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			const pick = (m: Mode) => { mode = m; overlayOpts.width = MODE_PCT[m]; refresh(); ctx.ui.notify(`pi-lens width: ${MODE_LABEL[m]}`, "info"); };
			if (arg === "regular" || arg === "focus" || arg === "sideshow") return pick(arg);
			if (ctx.mode !== "tui") return ctx.ui.notify("Usage: /lens-mode <regular|focus|sideshow>", "warning");
			const order: Mode[] = ["regular", "focus", "sideshow"];
			const choice = await ctx.ui.select("pi-lens drawer width", order.map((m) => MODE_LABEL[m]));
			if (!choice) return;
			pick(order[order.findIndex((m) => MODE_LABEL[m] === choice)] ?? "regular");
		},
	});

	pi.registerCommand("lens-close", {
		description: "Close the pi-lens drawer",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (tabs.length || handle) { closeAll(); ctx.ui.notify("pi-lens closed", "info"); }
			else ctx.ui.notify("No lens open", "info");
		},
	});

	pi.registerShortcut(Key.ctrlShift("l"), {
		description: "pi-lens: toggle focus in/out of the drawer",
		handler: async (ctx) => {
			if (!handle) return ctx.ui.notify("No lens open — use /lens <path>", "info");
			if (handle.isFocused()) handle.unfocus();
			else handle.focus();
			refresh();
		},
	});
}
