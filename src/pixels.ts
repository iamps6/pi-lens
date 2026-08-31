/**
 * pixels.ts — pi-lens media engine
 *
 * Converts visual content (images, PDF pages) into ANSI block-character text
 * lines. Block characters are plain styled text, so they render correctly
 * anywhere in the TUI — including inside the floating drawer overlay, with
 * scrolling, tabs, and borders.
 *
 * Rendering uses QUADRANT blocks (▘▝▀▖▌▞▛▗▚▐▜▄▙▟█): each terminal cell carries
 * a 2×2 pixel block with 2 colors chosen by clustering — double the horizontal
 * resolution of naive half-blocks (the technique used by chafa).
 *
 * Dependencies (feature-detected; everything degrades gracefully):
 *  - pdfjs-dist       (pure JS)                → proper PDF text + page rasters
 *  - @napi-rs/canvas  (prebuilt native, npm)   → image decode + PDF page pixels
 */

import { readFileSync } from "node:fs";

/* eslint-disable @typescript-eslint/no-explicit-any */
let canvasMod: any | null | undefined; // undefined = not yet tried
let pdfjsMod: any | null | undefined;

async function getCanvas(): Promise<any | null> {
	if (canvasMod !== undefined) return canvasMod;
	try {
		const m = await import("@napi-rs/canvas");
		const g = globalThis as any;
		g.DOMMatrix ??= m.DOMMatrix;
		g.Path2D ??= m.Path2D;
		g.ImageData ??= m.ImageData;
		canvasMod = m;
	} catch {
		canvasMod = null;
	}
	return canvasMod;
}

async function getPdfjs(): Promise<any | null> {
	if (pdfjsMod !== undefined) return pdfjsMod;
	try {
		await getCanvas(); // install DOM globals first if available
		pdfjsMod = await import("pdfjs-dist/legacy/build/pdf.mjs");
	} catch {
		pdfjsMod = null;
	}
	return pdfjsMod;
}

export async function hasCanvas(): Promise<boolean> {
	return (await getCanvas()) !== null;
}
export async function hasPdfjs(): Promise<boolean> {
	return (await getPdfjs()) !== null;
}

// ── quadrant-block renderer ─────────────────────────────────────────────────
const BG = 30; // blend transparent pixels onto dark gray

// glyph by 4-bit mask: bit0=TL bit1=TR bit2=BL bit3=BR (bit set = fg)
const QUAD = [" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"];

type RGB = [number, number, number];

/**
 * Render RGBA pixels as quadrant-block lines. `w` should be 2×cols, `h` is
 * arbitrary (2 pixel rows per cell row). Each cell picks the best 2-color
 * approximation of its 2×2 pixel block.
 */
export function quadrantBlocks(data: Uint8ClampedArray | Uint8Array, w: number, h: number): string[] {
	const px = (x: number, y: number): RGB => {
		if (x >= w || y >= h) return [BG, BG, BG];
		const i = (y * w + x) * 4;
		const a = (data[i + 3] ?? 0) / 255;
		return [
			Math.round((data[i] ?? 0) * a + BG * (1 - a)),
			Math.round((data[i + 1] ?? 0) * a + BG * (1 - a)),
			Math.round((data[i + 2] ?? 0) * a + BG * (1 - a)),
		];
	};
	const d2 = (a: RGB, b: RGB) => {
		const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
		return dr * dr + dg * dg + db * db;
	};
	const avg = (cs: RGB[]): RGB => {
		if (!cs.length) return [BG, BG, BG];
		let r = 0, g = 0, b = 0;
		for (const c of cs) { r += c[0]; g += c[1]; b += c[2]; }
		return [Math.round(r / cs.length), Math.round(g / cs.length), Math.round(b / cs.length)];
	};

	const cols = Math.ceil(w / 2);
	const lines: string[] = [];
	for (let cy = 0; cy * 2 < h; cy++) {
		let line = "";
		let prevFg = "", prevBg = "";
		for (let cx = 0; cx < cols; cx++) {
			const p: RGB[] = [px(cx * 2, cy * 2), px(cx * 2 + 1, cy * 2), px(cx * 2, cy * 2 + 1), px(cx * 2 + 1, cy * 2 + 1)];
			// seeds: the most distant pair among the 4 subpixels
			let si = 0, sj = 1, best = -1;
			for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
				const d = d2(p[i]!, p[j]!);
				if (d > best) { best = d; si = i; sj = j; }
			}
			let mask = 0;
			const fgList: RGB[] = [], bgList: RGB[] = [];
			for (let i = 0; i < 4; i++) {
				if (d2(p[i]!, p[si]!) <= d2(p[i]!, p[sj]!)) { mask |= 1 << i; fgList.push(p[i]!); }
				else bgList.push(p[i]!);
			}
			let fg = avg(fgList), bg = avg(bgList);
			if (mask === 15) { bg = fg; } // uniform cell
			const fgS = `${fg[0]};${fg[1]};${fg[2]}`;
			const bgS = `${bg[0]};${bg[1]};${bg[2]}`;
			if (fgS !== prevFg) { line += `\x1b[38;2;${fgS}m`; prevFg = fgS; }
			if (bgS !== prevBg) { line += `\x1b[48;2;${bgS}m`; prevBg = bgS; }
			line += QUAD[mask];
		}
		lines.push(line + "\x1b[0m");
	}
	return lines;
}

// ── images ──────────────────────────────────────────────────────────────────
export interface CellsResult {
	lines: string[];
	pxW: number;
	pxH: number;
}

/**
 * Decode an image file and render it as quadrant-block lines at `cols` cells
 * wide (2×cols pixels). Small images upscale at most 4x. Null if no canvas.
 */
export async function renderImageCells(path: string, cols: number): Promise<CellsResult | null> {
	const c = await getCanvas();
	if (!c) return null;
	const img = await c.loadImage(path);
	// target pixel grid: 2 px per cell horizontally; pixel aspect ≈ 1:2 (tall),
	// so vertical pixel count is halved to keep the image aspect correct.
	let w = Math.max(2, Math.min(cols * 2, img.width * 4));
	w += w % 2;
	let h = Math.max(2, Math.round((w * img.height) / img.width / 2));
	h += h % 2;
	const canvas = c.createCanvas(w, h);
	const ctx = canvas.getContext("2d");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(img, 0, 0, w, h);
	const data = ctx.getImageData(0, 0, w, h).data;
	return { lines: quadrantBlocks(data, w, h), pxW: w, pxH: h };
}

// ── PDFs ────────────────────────────────────────────────────────────────────
const MAX_PDF_TEXT = 400_000;
export const MAX_VISUAL_PAGES = 40;

// cache the last opened document (page navigation re-uses it)
let docCache: { path: string; doc: any } | null = null;

async function openDoc(path: string): Promise<any | null> {
	const pdfjs = await getPdfjs();
	if (!pdfjs) return null;
	if (docCache?.path === path) return docCache.doc;
	docCache?.doc?.destroy?.();
	docCache = null;
	const doc = await pdfjs.getDocument({
		data: new Uint8Array(readFileSync(path)),
		useSystemFonts: true,
	}).promise;
	docCache = { path, doc };
	return doc;
}

export interface PdfText {
	pageCount: number;
	text: string;
}

/** Proper text extraction via pdf.js (handles encodings the zlib hack cannot). */
export async function extractPdfTextRich(path: string): Promise<PdfText | null> {
	const doc = await openDoc(path);
	if (!doc) return null;
	const parts: string[] = [];
	let total = 0;
	for (let p = 1; p <= doc.numPages && total < MAX_PDF_TEXT; p++) {
		const page = await doc.getPage(p);
		const tc = await page.getTextContent();
		let line = "";
		const chunks: string[] = [];
		for (const item of tc.items as Array<{ str?: string; hasEOL?: boolean }>) {
			if (item.str) line += item.str;
			if (item.hasEOL) { chunks.push(line); line = ""; }
		}
		if (line) chunks.push(line);
		const pageText = chunks.join("\n").trim();
		parts.push(`── Page ${p}/${doc.numPages} ──\n\n${pageText || "(no text on this page)"}`);
		total += pageText.length;
	}
	return { pageCount: doc.numPages, text: parts.join("\n\n") };
}

async function rasterPageCanvas(c: any, page: any, pixelWidth: number): Promise<any> {
	const vp1 = page.getViewport({ scale: 1 });
	const scale = pixelWidth / vp1.width;
	const vp = page.getViewport({ scale });
	const canvas = c.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
	const ctx = canvas.getContext("2d");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
	return canvas;
}

/**
 * Render PDF pages progressively as quadrant-block lines at `cols` cells wide.
 * Calls `onPage(lines, pageNum, pageCount)` after each page. Returns pageCount
 * (or null if canvas/pdfjs unavailable). Renders at most MAX_VISUAL_PAGES.
 */
export async function renderPdfPages(
	path: string,
	cols: number,
	onPage: (lines: string[], pageNum: number, pageCount: number) => void,
): Promise<number | null> {
	const c = await getCanvas();
	const doc = await openDoc(path);
	if (!c || !doc) return null;
	// PDF pages: pixel aspect 1:2 → halve vertical resolution relative to width.
	const pixelW = Math.max(20, cols * 2);
	const n = Math.min(doc.numPages, MAX_VISUAL_PAGES);
	for (let p = 1; p <= n; p++) {
		const page = await doc.getPage(p);
		const full = await rasterPageCanvas(c, page, pixelW);
		// vertical squeeze to half height (pixel aspect is 1:2 in quadrant cells)
		const sq = c.createCanvas(full.width, Math.max(2, Math.round(full.height / 2)));
		const sctx = sq.getContext("2d");
		sctx.imageSmoothingEnabled = true;
		sctx.imageSmoothingQuality = "high";
		sctx.drawImage(full, 0, 0, full.width, full.height, 0, 0, sq.width, sq.height);
		const d = sctx.getImageData(0, 0, sq.width, sq.height).data;
		onPage(quadrantBlocks(d, sq.width, sq.height), p, doc.numPages);
	}
	return doc.numPages;
}

/** Hi-res PNG of a single page (for the belowEditor native-protocol widget). */
export async function renderPdfPagePng(path: string, pageNum: number): Promise<{ pngB64: string; pageCount: number } | null> {
	const c = await getCanvas();
	const doc = await openDoc(path);
	if (!c || !doc) return null;
	const n = Math.min(Math.max(1, pageNum), doc.numPages);
	const page = await doc.getPage(n);
	const vp1 = page.getViewport({ scale: 1 });
	const scale = Math.min(1600 / vp1.width, 4);
	const vp = page.getViewport({ scale });
	const canvas = c.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
	return { pngB64: canvas.toBuffer("image/png").toString("base64"), pageCount: doc.numPages };
}
