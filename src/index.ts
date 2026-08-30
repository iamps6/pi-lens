/**
 * file-preview — in-terminal file previews for pi
 *
 * Commands:
 *   /preview <path>        Open a file in a scrollable overlay viewer (modal)
 *   /drawer  <path>        Open a persistent right-side drawer (stays while you chat)
 *   /drawer-close          Close the drawer
 *
 * Supported: .md/.markdown, images (png/jpg/gif/webp/bmp), text/code, .pdf (text extraction).
 * Zero system dependencies. PDF uses node:zlib for FlateDecode text extraction.
 */

import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { inflateSync, inflateRawSync } from "node:zlib";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Image,
	Markdown,
	matchesKey,
	Text,
	visibleWidth,
} from "@earendil-works/pi-tui";

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

const MD_EXT = new Set([".md", ".markdown", ".mdx"]);

type Kind = "image" | "markdown" | "text" | "pdf";

function classify(path: string): Kind {
	const ext = extname(path).toLowerCase();
	if (ext in IMAGE_MIME) return "image";
	if (MD_EXT.has(ext)) return "markdown";
	if (ext === ".pdf") return "pdf";
	return "text";
}

/** Naive, dependency-free PDF text extraction. Good enough for readable previews. */
function extractPdfText(buf: Buffer): string {
	const out: string[] = [];
	let i = 0;
	const needle = Buffer.from("stream");
	const endNeedle = Buffer.from("endstream");
	while (i < buf.length) {
		const s = buf.indexOf(needle, i);
		if (s === -1) break;
		let dataStart = s + needle.length;
		// skip CRLF / LF after "stream"
		if (buf[dataStart] === 0x0d) dataStart++;
		if (buf[dataStart] === 0x0a) dataStart++;
		const e = buf.indexOf(endNeedle, dataStart);
		if (e === -1) break;
		const chunk = buf.subarray(dataStart, e);
		i = e + endNeedle.length;

		let text: string | undefined;
		for (const fn of [inflateSync, inflateRawSync]) {
			try {
				text = fn(chunk).toString("latin1");
				break;
			} catch {
				/* not this codec */
			}
		}
		if (text === undefined) {
			// maybe uncompressed content stream
			const raw = chunk.toString("latin1");
			if (/\)\s*Tj|\]\s*TJ|BT[\s\S]*ET/.test(raw)) text = raw;
		}
		if (text) {
			const piece = decodeContentStreamText(text);
			if (piece.trim()) out.push(piece);
		}
	}
	return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Pull text out of PDF content-stream operators (Tj, TJ, and Td/TD/T* line breaks). */
function decodeContentStreamText(s: string): string {
	let res = "";
	const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[dDj*]\b|\bTJ\b|\bTd\b/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) {
		const tok = m[0];
		if (tok.startsWith("(")) {
			res += unescapePdfString(tok.slice(1, -1));
		} else if (tok.startsWith("<")) {
			res += hexToStr(tok.slice(1, -1));
		} else if (tok === "Td" || tok === "TD" || tok === "T*") {
			res += "\n";
		}
	}
	return res;
}

function unescapePdfString(s: string): string {
	return s
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\\(/g, "(")
		.replace(/\\\)/g, ")")
		.replace(/\\\\/g, "\\")
		.replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

function hexToStr(h: string): string {
	const clean = h.replace(/\s+/g, "");
	let out = "";
	for (let i = 0; i + 1 < clean.length; i += 2) {
		out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
	}
	return out;
}

interface ViewerResult {
	closed: true;
}

/** A scrollable viewer component for text/markdown/pdf, or a fit-to-screen image. */
class Viewer {
	focused = true;
	private scroll = 0;
	private lineCache: string[] | null = null;
	private cacheWidth = -1;

	constructor(
		private theme: Theme,
		private title: string,
		private kind: Kind,
		private content: string, // text/markdown/pdf source
		private imageBase64: string | undefined,
		private imageMime: string | undefined,
		private done: (r: ViewerResult) => void,
		private heightFrac = 0.8,
	) {}

	private viewportRows(): number {
		const rows = process.stdout.rows || 40;
		return Math.max(5, Math.floor(rows * this.heightFrac) - 4); // title+footer+borders
	}

	private buildLines(width: number): string[] {
		if (this.lineCache && this.cacheWidth === width) return this.lineCache;
		const inner = Math.max(10, width);
		let lines: string[];
		if (this.kind === "image" && this.imageBase64 && this.imageMime) {
			const img = new Image(
				this.imageBase64,
				this.imageMime,
				{ fallbackColor: (s: string) => this.theme.fg("dim", s) },
				{ maxWidthCells: inner, maxHeightCells: this.viewportRows() },
			);
			lines = img.render(inner);
		} else if (this.kind === "markdown") {
			lines = new Markdown(this.content, 0, 0, getMarkdownTheme()).render(inner);
		} else {
			// text / pdf → render as fenced-ish plain text via Markdown code styling is risky;
			// just show raw lines with dim gutter.
			lines = this.content
				.split("\n")
				.flatMap((l) => wrap(l, inner));
		}
		this.lineCache = lines;
		this.cacheWidth = width;
		return lines;
	}

	render(width: number): string[] {
		const t = this.theme;
		const all = this.buildLines(width);
		const vh = this.viewportRows();
		const maxScroll = Math.max(0, all.length - vh);
		if (this.scroll > maxScroll) this.scroll = maxScroll;

		const header = t.fg("accent", t.bold(`  ${this.title}`));
		const isImage = this.kind === "image";
		const body = isImage ? all : all.slice(this.scroll, this.scroll + vh);

		const pct = all.length <= vh ? 100 : Math.round((this.scroll / maxScroll) * 100);
		const hint = isImage
			? "esc/q close"
			: `↑/↓ scroll · space/pgdn page · g/G top/bottom · esc/q close   [${pct}%]`;
		const footer = t.fg("dim", `  ${hint}`);

		return [header, t.fg("borderMuted", "  " + "─".repeat(Math.max(0, width - 4))), ...body, footer];
	}

	invalidate(): void {
		this.lineCache = null;
		this.cacheWidth = -1;
	}

	handleInput(data: string): void {
		const vh = this.viewportRows();
		if (matchesKey(data, "escape") || data === "q") return this.done({ closed: true });
		if (this.kind === "image") return;
		if (matchesKey(data, "up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, "down") || data === "j") this.scroll += 1;
		else if (data === " " || matchesKey(data, "pagedown")) this.scroll += vh - 1;
		else if (matchesKey(data, "pageup")) this.scroll = Math.max(0, this.scroll - (vh - 1));
		else if (data === "g") this.scroll = 0;
		else if (data === "G") this.scroll = Number.MAX_SAFE_INTEGER; // clamped in render
	}
}

function wrap(line: string, width: number): string[] {
	if (visibleWidth(line) <= width) return [line || ""];
	const out: string[] = [];
	let cur = "";
	for (const ch of line) {
		if (visibleWidth(cur + ch) > width) {
			out.push(cur);
			cur = ch;
		} else cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

interface Loaded {
	title: string;
	kind: Kind;
	content: string;
	imageBase64?: string;
	imageMime?: string;
}

function load(path: string): Loaded {
	const abs = resolve(path);
	const title = basename(abs);
	const kind = classify(abs);
	if (kind === "image") {
		const base64 = readFileSync(abs).toString("base64");
		return { title, kind, content: "", imageBase64: base64, imageMime: IMAGE_MIME[extname(abs).toLowerCase()] };
	}
	if (kind === "pdf") {
		const text = extractPdfText(readFileSync(abs));
		return {
			title: `${title}  (extracted text)`,
			kind: "pdf",
			content: text || "(no extractable text — this PDF may be scanned/image-only)",
		};
	}
	return { title, kind, content: readFileSync(abs, "utf8") };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("preview", {
		description: "Preview a file in a scrollable terminal overlay",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const path = args.trim();
			if (!path) return ctx.ui.notify("Usage: /preview <path>", "warning");
			if (ctx.mode !== "tui") return ctx.ui.notify("Preview requires the TUI", "warning");

			let data: Loaded;
			try {
				data = load(path);
			} catch (e) {
				return ctx.ui.notify(`Cannot read ${path}: ${(e as Error).message}`, "error");
			}

			await ctx.ui.custom<ViewerResult>(
				(_tui, theme, _kb, done) =>
					new Viewer(theme, data.title, data.kind, data.content, data.imageBase64, data.imageMime, done),
				{
					overlay: true,
					overlayOptions: { width: "80%", maxHeight: "85%", anchor: "center" },
				},
			);
		},
	});

	// Persistent right-side drawer that stays visible while you keep chatting.
	let drawerClose: (() => void) | null = null;
	pi.registerCommand("drawer", {
		description: "Open a file in a persistent right-side drawer",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const path = args.trim();
			if (!path) return ctx.ui.notify("Usage: /drawer <path>", "warning");
			if (ctx.mode !== "tui") return ctx.ui.notify("Drawer requires the TUI", "warning");

			let data: Loaded;
			try {
				data = load(path);
			} catch (e) {
				return ctx.ui.notify(`Cannot read ${path}: ${(e as Error).message}`, "error");
			}

			drawerClose?.();

			// Do NOT await — keep the overlay open and hand input back to the editor.
			void ctx.ui.custom<ViewerResult>(
				(_tui, theme, _kb, done) =>
					new Viewer(theme, data.title, data.kind, data.content, data.imageBase64, data.imageMime, done, 0.95),
				{
					overlay: true,
					overlayOptions: { anchor: "right-center", width: "42%", maxHeight: "95%", margin: 1 },
					onHandle: (handle) => {
						// stay visible but release input so the user keeps typing to pi
						handle.unfocus();
						drawerClose = () => {
							handle.hide();
							drawerClose = null;
						};
					},
				},
			);
			ctx.ui.notify("Drawer open (keep chatting) · /drawer-close to dismiss", "info");
		},
	});

	pi.registerCommand("drawer-close", {
		description: "Close the file preview drawer",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (drawerClose) {
				drawerClose();
				ctx.ui.notify("Drawer closed", "info");
			} else {
				ctx.ui.notify("No drawer open", "info");
			}
		},
	});
}
