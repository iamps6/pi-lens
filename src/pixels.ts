/**
 * pixels.ts — pi-lens media engine
 *
 * Converts visual content (images, PDF pages) into ANSI half-block text lines
 * (`▀` with truecolor fg/bg = 2 vertical pixels per cell). Half-blocks are plain
 * styled text, so they render correctly anywhere in the TUI — including inside
 * the floating drawer overlay, with scrolling, tabs, and borders.
 *
 * Dependencies (both feature-detected; everything degrades gracefully):
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

// ── half-block renderer ─────────────────────────────────────────────────────
const BG = 30; // blend transparent pixels onto dark gray

/** Convert RGBA pixels to ANSI half-block lines (2 pixels per row of cells). */
export function halfBlocks(data: Uint8ClampedArray | Uint8Array, w: number, h: number): string[] {
	const px = (x: number, y: number): [number, number, number] => {
		const i = (y * w + x) * 4;
		const a = (data[i + 3] ?? 0) / 255;
		return [
			Math.round((data[i] ?? 0) * a + BG * (1 - a)),
			Math.round((data[i + 1] ?? 0) * a + BG * (1 - a)),
			Math.round((data[i + 2] ?? 0) * a + BG * (1 - a)),
		];
	};
	const lines: string[] = [];
	for (let y = 0; y < h; y += 2) {
		let line = "";
		let prevFg = "", prevBg = "";
		for (let x = 0; x < w; x++) {
			const [tr, tg, tb] = px(x, y);
			const hasBottom = y + 1 < h;
			const [br, bg, bb] = hasBottom ? px(x, y + 1) : [BG, BG, BG];
			const fg = `${tr};${tg};${tb}`;
			const bgc = `${br};${bg};${bb}`;
			if (fg !== prevFg) { line += `\x1b[38;2;${fg}m`; prevFg = fg; }
			if (bgc !== prevBg) { line += `\x1b[48;2;${bgc}m`; prevBg = bgc; }
			line += "▀";
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
 * Decode an image file and render it as half-block lines at `cols` cells wide.
 * Small images are upscaled at most 4x. Returns null if canvas is unavailable.
 */
export async function renderImageCells(path: string, cols: number): Promise<CellsResult | null> {
	const c = await getCanvas();
	if (!c) return null;
	const img = await c.loadImage(path);
	const w = Math.max(1, Math.min(cols, img.width * 4));
	const h = Math.max(1, Math.round((w * img.height) / img.width));
	const canvas = c.createCanvas(w, h);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(img, 0, 0, w, h);
	const data = ctx.getImageData(0, 0, w, h).data;
	return { lines: halfBlocks(data, w, h), pxW: w, pxH: h };
}

// ── PDFs ────────────────────────────────────────────────────────────────────
const MAX_PDF_TEXT = 400_000;

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

/** Proper text extraction via pdf.js (handles encodings my zlib hack cannot). */
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

export interface PageRender extends CellsResult {
	pageCount: number;
	pngB64: string; // hi-res PNG of the page for the belowEditor widget
}

/** Rasterize one PDF page → half-block lines at `cols` wide + a hi-res PNG. */
export async function renderPdfPageCells(path: string, pageNum: number, cols: number): Promise<PageRender | null> {
	const c = await getCanvas();
	const doc = await openDoc(path);
	if (!c || !doc) return null;
	const n = Math.min(Math.max(1, pageNum), doc.numPages);
	const page = await doc.getPage(n);
	const vp1 = page.getViewport({ scale: 1 });

	// half-block raster at drawer width (rows = pxH / 2)
	const w = Math.max(10, cols);
	const scale = w / vp1.width;
	const vp = page.getViewport({ scale });
	const canvas = c.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
	const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

	// hi-res PNG for the native-protocol widget (readable text)
	const pngScale = Math.min(1600 / vp1.width, 4);
	const vpx = page.getViewport({ scale: pngScale });
	const big = c.createCanvas(Math.ceil(vpx.width), Math.ceil(vpx.height));
	const bctx = big.getContext("2d");
	bctx.fillStyle = "#ffffff";
	bctx.fillRect(0, 0, big.width, big.height);
	await page.render({ canvasContext: bctx, viewport: vpx, canvas: big }).promise;
	const pngB64 = big.toBuffer("image/png").toString("base64");

	return {
		lines: halfBlocks(data, canvas.width, canvas.height),
		pxW: canvas.width,
		pxH: canvas.height,
		pageCount: doc.numPages,
		pngB64,
	};
}
