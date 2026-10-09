/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * glyphAtlas.ts — glyph coverage atlas: CPU page allocation, shelf packing,
 * density-band quantization, and Atlas Paging + Flush eviction (plan
 * §3.2/§6 — deliberately NO per-glyph LRU: evicting single glyphs inside a
 * GPU texture turns eviction into 2D bin-packing fragmentation management
 * that costs more than it saves).
 *
 * PURE CPU MODULE (no DOM, no GPU): grayscale coverage pages are plain
 * `Uint8Array` bitmaps (one byte per texel — the same coverage-in-`.r`
 * convention the engine uses for `r8unorm` masks). The consumer
 * (`TextRenderer`) owns GPU page textures and uploads dirty pages; glyph
 * INK is produced by an injected `GlyphRasterizer` (Canvas2D in production,
 * a stub in tests).
 *
 * ── DENSITY BANDS ──
 * Grayscale coverage upsamples BLURRY (a 1-2px transition band stretched 3×
 * stays blurry) — unlike an SDF's analytic edge, so the atlas MUST be
 * rasterized at the target physical font size: `rasterSize = fontSize × band`.
 * `quantizeDensityBand` snaps an arbitrary target density UP to one of a few
 * bands (upsampling is never allowed; downsampling a higher band linearly is
 * acceptable). The interactive path is pinned to band 1 this phase (P3 makes
 * it viewport-density aware); the export path quantizes `exportScale`.
 *
 * ── PAGING + FLUSH ──
 * Each atlas set (fontKey × band) holds at most `MAX_PAGES_PER_SET` pages of
 * `ATLAS_PAGE_SIZE²` bytes, filled with a simple shelf (row) packer. When a
 * placement no longer fits and all pages of the set are full, the set is
 * queued for FLUSH and the request reports the glyph as MISSING for the
 * current frame. The flush is applied at the START of the next frame
 * (`beginFrame`): the whole set is dropped, and only the glyphs requested by
 * the next frame's visible text layers are re-rasterized. Deferring the flush
 * to a frame boundary keeps every draw within one frame sampling a consistent
 * atlas (a mid-frame flush would invalidate UVs of draws already encoded).
 *
 * @module core/engine/text/glyphAtlas
 */

/** Edge padding (px) around each glyph's ink box — keeps linear sampling from bleeding neighbours in. */
export const GLYPH_PAD_PX = 2;

/** Atlas page edge length in texels (2048² grayscale = 4 MiB per page). */
export const ATLAS_PAGE_SIZE = 2048;

/** Pages per atlas set before the set is queued for a full flush. */
export const MAX_PAGES_PER_SET = 2;

/** Hard cap on a single glyph's raster dimension — bigger requests clamp to
 * this size and the quad samples the clamped raster with a bilinear upscale
 * (anti font-loss guarantee), rather than skipping the glyph entirely. */
export const MAX_GLYPH_RASTER_SIZE = 512;

/**
 * Quantized density bands. A glyph rasterized at band B sampled at target
 * density d ≤ B never upsamples (sharp); d > B would, so quantization rounds UP.
 */
export const DENSITY_BANDS = [1, 1.5, 2, 3, 4] as const;

/**
 * Snap a target density UP to the smallest band that covers it (largest band
 * when above every band). Band 1 covers the interactive path this phase.
 */
export function quantizeDensityBand(density: number): number {
  const d = Math.max(1, density);
  for (const band of DENSITY_BANDS) {
    if (d <= band) return band;
  }
  return DENSITY_BANDS[DENSITY_BANDS.length - 1];
}

/** A glyph's allocated slot in the atlas, in normalized UV + logical-px metrics. */
export interface GlyphPlacement {
  /** Page index within the set (bind group selection). */
  readonly page: number;
  /** Ink-box UV rect (normalized, pad EXCLUDED — pad only guards sampling). */
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  /** Ink width in LOGICAL px (quad size on the layout grid). */
  readonly inkW: number;
  /** Ink height in LOGICAL px. */
  readonly inkH: number;
  /** Ink ascent in LOGICAL px — quad top sits at `baselineY - inkAscent`. */
  readonly inkAscent: number;
  /** Pen→ink-left offset in LOGICAL px — quad left sits at `penX - inkLeft`. */
  readonly inkLeft: number;
}

/** Ink metrics for one character in the RASTERIZER's pixel space (physical px). */
export interface GlyphMetrics {
  readonly inkW: number;
  readonly inkH: number;
  readonly inkAscent: number;
  /**
   * Horizontal offset from the pen origin to the ink's LEFT edge (physical px,
   * same sign convention as `actualBoundingBoxLeft`: positive = ink extends
   * LEFT of the pen). The rasterizer draws at this offset so the cell's column
   * 0 is the ink's left edge, and the consumer places the quad at
   * `penX - inkLeft` — glyphs with a left side bearing (ink right of the pen,
   * the usual case) would otherwise be clipped on their right edge.
   */
  readonly inkLeft: number;
}

/**
 * Glyph ink producer, injected so this module stays DOM-free. `measure` runs
 * in the rasterizer's pxSize space — PHYSICAL px (`pxSize = fontSize × band`);
 * the atlas divides by the band to recover logical metrics for the quad.
 * `raster` draws the glyph ink into the page bitmap at the given cell origin
 * (the caller has already reserved pad margins around the ink box).
 */
export interface GlyphRasterizer {
  /** CSS font string, e.g. `italic 400 24px sans-serif`. */
  font(fontFamily: string, fontWeight: number, italic: boolean, rasterFontSize: number): string;
  measure(text: string, font: string, rasterFontSize: number): GlyphMetrics;
  /**
   * Draw one glyph's ink into the page bitmap at the given cell origin (the
   * caller has already reserved pad margins around the ink box). `metrics` is
   * the ink box `measure` returned for the same (text, font, rasterFontSize) —
   * passed through so implementations don't re-measure.
   */
  rasterize(
    text: string,
    font: string,
    rasterFontSize: number,
    metrics: GlyphMetrics,
    into: Uint8Array,
    pageSize: number,
    x: number,
    y: number,
  ): void;
}

/** One shelf-packed grayscale page. */
class AtlasPage {
  readonly data: Uint8Array;
  /** Bumped whenever ink is written — the consumer uploads pages whose version moved. */
  version = 0;
  /** Shelf allocator state: y of the next free row, x of the free run on that row, row height. */
  private shelfY = 0;
  private shelfX = 0;
  private shelfH = 0;

  constructor(readonly size: number) {
    this.data = new Uint8Array(size * size);
  }

  /** Reserve a w×h cell (pad already included by the caller); null when the page is full. */
  allocate(w: number, h: number): { x: number; y: number } | null {
    if (w > this.size || h > this.size) return null;
    if (this.shelfX + w > this.size) {
      // Row overflow — advance to the next shelf.
      this.shelfY += this.shelfH;
      this.shelfX = 0;
      this.shelfH = 0;
    }
    if (this.shelfY + h > this.size) return null;
    const pos = { x: this.shelfX, y: this.shelfY };
    this.shelfX += w;
    this.shelfH = Math.max(this.shelfH, h);
    return pos;
  }
}

interface GlyphEntry {
  readonly placement: GlyphPlacement;
  /** Page the ink was rasterized into (for dirty tracking). */
  readonly pageIndex: number;
}

/** One atlas set: all pages + placements for a single (fontKey × band). */
class AtlasSet {
  readonly pages: AtlasPage[] = [];
  readonly glyphs = new Map<string, GlyphEntry>();
  /** Set when full — flush deferred to the next `beginFrame` (see module header). */
  flushPending = false;

  constructor(readonly key: string, readonly band: number) {}

  /** Reserved all-white 1×1 UV used by decoration quads (underline/strikethrough). */
  decoUV: DecoPixel | null = null;
}

/** A page whose pixels changed since the consumer last uploaded it. */
export interface DirtyPage {
  readonly setKey: string;
  readonly pageIndex: number;
  readonly data: Uint8Array;
  /** The page version this dirty report carries (for consumer-side dedup). */
  readonly version: number;
}

/** The reserved all-white pixel decoration quads sample: solid coverage 1. */
export interface DecoPixel {
  /** Page the pixel was placed on — usually 0, but a full page 0 pushes it to
   * the next page, so consumers must sample THIS page, never a hardcoded one. */
  readonly page: number;
  /** Ink-box UV rect (normalized, pad excluded). */
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/** Result of one batched per-layer request. */
export interface AtlasRequestResult {
  /** Placement per requested glyph key, in request order (null = missing this frame). */
  readonly placements: (GlyphPlacement | null)[];
  /** UV of the reserved decoration pixel (solid coverage 1). */
  readonly decoUV: DecoPixel | null;
}

/** One glyph to place: identity + logical size. */
export interface GlyphRequest {
  /** The character (single code point). */
  readonly char: string;
  readonly fontSize: number;
}

const DECO_CHAR = '\u0000';

/**
 * Glyph atlas cache: keyed by (fontKey × band). Pure CPU — GPU page textures
 * and Canvas2D rasterization live in the consumer / injected rasterizer.
 */
export class GlyphAtlasCache {
  private readonly sets = new Map<string, AtlasSet>();
  /** Bumped on every flush; consumers drop their GPU page textures when it moves. */
  generation = 0;

  /** Frame boundary: apply deferred flushes BEFORE this frame's requests. */
  beginFrame(): void {
    for (const [key, set] of this.sets) {
      if (set.flushPending) {
        this.sets.delete(key);
        this.generation++;
      }
    }
  }

  /** Drop every set rasterized at `band` (export path: one-shot, use then release). */
  evictBand(band: number): void {
    for (const [key, set] of this.sets) {
      if (set.band === band) {
        this.sets.delete(key);
        this.generation++;
      }
    }
  }

  hasSet(setKey: string): boolean {
    return this.sets.has(setKey);
  }

  /**
   * Batched request for one text layer's glyphs. Returns placements in order;
   * an entry is null when the glyph cannot be placed this frame (set full →
   * deferred flush, or single glyph over the raster cap). Glyphs already in
   * the atlas return their stable placement immediately.
   */
  request(
    setKey: string,
    fontKey: string,
    band: number,
    fontFamily: string,
    fontWeight: number,
    italic: boolean,
    requests: readonly GlyphRequest[],
    rasterizer: GlyphRasterizer,
  ): AtlasRequestResult {
    const set = this.sets.get(setKey) ?? this.createSet(setKey, band);
    const placements: (GlyphPlacement | null)[] = new Array(requests.length);

    for (let i = 0; i < requests.length; i++) {
      const req = requests[i];
      const glyphKey = `${req.char}\u0000${req.fontSize}`;
      const existing = set.glyphs.get(glyphKey);
      if (existing) {
        placements[i] = existing.placement;
        continue;
      }
      if (set.flushPending) {
        // Set is full and waiting for next-frame flush — skip rather than
        // place into an atlas that is about to be dropped.
        placements[i] = null;
        continue;
      }
      const pxSize = req.fontSize * band;
      if (!Number.isFinite(pxSize) || pxSize <= 0) {
        placements[i] = null;
        continue;
      }
      // Over the raster cap: clamp the RASTER size and keep going. The ink is
      // rasterized at MAX_GLYPH_RASTER_SIZE and its metrics pre-scaled so the
      // logical quad still occupies the full glyph extent — the quad samples
      // the smaller raster with a bilinear upscale (slightly soft, never
      // MISSING). Skipping here would silently drop glyphs for huge font
      // sizes × high density bands (e.g. 200px at band 3 = 600px > cap).
      const rasterScale = pxSize > MAX_GLYPH_RASTER_SIZE ? MAX_GLYPH_RASTER_SIZE / pxSize : 1;
      const rasterFontSize = pxSize * rasterScale;
      const font = rasterizer.font(fontFamily, fontWeight, italic, rasterFontSize);
      const mRaw = req.char === DECO_CHAR
        ? { inkW: 1, inkH: 1, inkAscent: 1, inkLeft: 0 }
        : rasterizer.measure(req.char, font, rasterFontSize);
      if (
        !Number.isFinite(mRaw.inkW) || !Number.isFinite(mRaw.inkH) ||
        mRaw.inkW <= 0 || mRaw.inkH <= 0
      ) {
        // Unmeasurable glyph (e.g. whitespace-only ink box): skip without flush.
        placements[i] = null;
        continue;
      }
      // Unplaceable glyph: drawn ink larger than the biggest cell a page can
      // hold (checked in DRAWN space — mRaw is measured at the clamped raster
      // size, which is the space the cell actually allocates; comparing the
      // pxSize-space logical metrics here would reject every legitimately huge
      // glyph and permanently blank the layer). MAX_GLYPH_RASTER_SIZE is a
      // raster QUALITY cap, not a placement bound — real fonts legitimately
      // overshoot their em slightly (italic f/j, swashes, sub-pixel rounding),
      // so the bound is the page size minus the pad margins. Above it no
      // flush would help either.
      if (
        Math.ceil(mRaw.inkW) > ATLAS_PAGE_SIZE - GLYPH_PAD_PX * 2 ||
        Math.ceil(mRaw.inkH) > ATLAS_PAGE_SIZE - GLYPH_PAD_PX * 2
      ) {
        placements[i] = null;
        continue;
      }
      // LOGICAL metrics stay in the ORIGINAL pxSize space (placeGlyph divides
      // by band for the quad); only the raster happened at the clamped size.
      const logical =
        rasterScale === 1
          ? mRaw
          : {
              inkW: mRaw.inkW / rasterScale,
              inkH: mRaw.inkH / rasterScale,
              inkAscent: mRaw.inkAscent / rasterScale,
              inkLeft: mRaw.inkLeft / rasterScale,
            };
      // Cell + UV are sized by the DRAWN ink (mRaw), logical quad metrics by
      // `logical` — the quad spans the full glyph extent and samples the
      // smaller raster with a bilinear upscale (soft beyond the raster cap,
      // never MISSING, and the cell never exceeds the raster cap + pad, so a
      // glyph can always be allocated and the set can't enter a permanent
      // flush cycle at huge font sizes).
      const placed = this.placeGlyph(set, req.char, font, rasterFontSize, mRaw, logical, rasterizer);
      if (placed) {
        set.glyphs.set(glyphKey, placed);
        placements[i] = placed.placement;
      } else {
        // Page-full is the only remaining failure — queue the flush and
        // report missing for this frame.
        set.flushPending = true;
        placements[i] = null;
      }
    }

    this.ensureDecoPixel(set, fontFamily, fontWeight, italic, rasterizer);
    return { placements, decoUV: set.decoUV };
  }

  /**
   * Pages whose pixels changed since the last `takeDirtyPages` — the consumer
   * uploads each to its GPU texture (whole-page write; dirtiness is rare).
   * `since` maps `setKey:pageIndex` → last-seen page version; mutated in place.
   */
  takeDirtyPages(since: Map<string, number>): DirtyPage[] {
    const out: DirtyPage[] = [];
    for (const [setKey, set] of this.sets) {
      for (let i = 0; i < set.pages.length; i++) {
        const page = set.pages[i];
        const key = `${setKey}:${i}`;
        if (page.version === since.get(key)) continue;
        since.set(key, page.version);
        out.push({ setKey, pageIndex: i, data: page.data, version: page.version });
      }
    }
    return out;
  }

  private createSet(setKey: string, band: number): AtlasSet {
    const set = new AtlasSet(setKey, band);
    this.sets.set(setKey, set);
    return set;
  }

  /** Reserve the all-white 1×1 pixel decoration quads sample (coverage 1). */
  private ensureDecoPixel(
    set: AtlasSet,
    fontFamily: string,
    fontWeight: number,
    italic: boolean,
    rasterizer: GlyphRasterizer,
  ): boolean {
    if (set.decoUV) return false;
    const rasterFontSize = set.band;
    const font = rasterizer.font(fontFamily, fontWeight, italic, rasterFontSize);
    const onePx = { inkW: 1, inkH: 1, inkAscent: 1, inkLeft: 0 };
    const placed = this.placeGlyph(set, DECO_CHAR, font, rasterFontSize, onePx, onePx, rasterizer);
    if (!placed) return false;
    set.decoUV = {
      page: placed.pageIndex,
      u0: placed.placement.u0,
      v0: placed.placement.v0,
      u1: placed.placement.u1,
      v1: placed.placement.v1,
    };
    return true;
  }

  /**
   * Allocate + rasterize one glyph. `drawn` are the ink metrics in the
   * rasterizer's rasterFontSize space — they size the CELL and the UV rect
   * and are what `rasterize` actually draws. `logical` are the ink metrics in
   * pxSize space — they become the placement's logical quad metrics (divided
   * by the band). The two are identical below the raster cap and decoupled
   * above it (drawn stays at the cap, the quad upscales). The only failure
   * mode left is page-full (returns null, caller queues a flush) — cap and
   * measurability checks already ran in `request`.
   */
  private placeGlyph(
    set: AtlasSet,
    char: string,
    font: string,
    rasterFontSize: number,
    drawn: GlyphMetrics,
    logical: GlyphMetrics,
    rasterizer: GlyphRasterizer,
  ): GlyphEntry | null {
    const band = set.band;
    // Physical raster rect (the atlas texels the glyph occupies).
    const rasterW = Math.max(1, Math.ceil(drawn.inkW));
    const rasterH = Math.max(1, Math.ceil(drawn.inkH));

    const cellW = rasterW + GLYPH_PAD_PX * 2;
    const cellH = rasterH + GLYPH_PAD_PX * 2;

    let pageIndex = -1;
    let pos: { x: number; y: number } | null = null;
    for (let i = 0; i < set.pages.length; i++) {
      pos = set.pages[i].allocate(cellW, cellH);
      if (pos) {
        pageIndex = i;
        break;
      }
    }
    if (pageIndex < 0) {
      if (set.pages.length >= MAX_PAGES_PER_SET) {
        set.flushPending = true;
        return null;
      }
      const page = new AtlasPage(ATLAS_PAGE_SIZE);
      set.pages.push(page);
      pos = page.allocate(cellW, cellH);
      pageIndex = set.pages.length - 1;
    }
    if (!pos) return null;

    const page = set.pages[pageIndex];
    const inkX = pos.x + GLYPH_PAD_PX;
    const inkY = pos.y + GLYPH_PAD_PX;

    // Zero the cell (fresh pages are zero already; re-allocated shelves on a
    // reused page are not — but pages are never partially freed in this design,
    // so only fresh pages reach here. The zero fill is free insurance.)
    for (let row = 0; row < cellH; row++) {
      page.data.fill(0, (pos.y + row) * ATLAS_PAGE_SIZE + pos.x, (pos.y + row) * ATLAS_PAGE_SIZE + pos.x + cellW);
    }

    if (char === DECO_CHAR) {
      // Solid white pixel — the decoration quad's coverage source.
      page.data[inkY * ATLAS_PAGE_SIZE + inkX] = 255;
    } else {
      // Draw ink into the pad margins' interior; cell ink origin is (inkX, inkY).
      rasterizer.rasterize(char, font, rasterFontSize, drawn, page.data, ATLAS_PAGE_SIZE, inkX, inkY);
    }
    page.version++;

    const pageSize = ATLAS_PAGE_SIZE;
    return {
      pageIndex,
      placement: {
        page: pageIndex,
        u0: inkX / pageSize,
        v0: inkY / pageSize,
        u1: (inkX + rasterW) / pageSize,
        v1: (inkY + rasterH) / pageSize,
        // `logical` is in physical pxSize space — divide by the band for the
        // LOGICAL metrics the renderer's quad uses on the layout grid.
        inkW: logical.inkW / band,
        inkH: logical.inkH / band,
        inkAscent: logical.inkAscent / band,
        inkLeft: logical.inkLeft / band,
      },
    };
  }
}
