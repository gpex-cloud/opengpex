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
 * TextRenderer.ts — Vector render strategy: instanced glyph quads over a
 * grayscale coverage atlas (Layer B). The CPU layout is NOT re-computed here —
 * `TextParams.layout` (from `computeTextLayout`, the single layout source of
 * truth) already carries per-line text, per-character x offsets, baselines and
 * decoration rects in LOGICAL px; this strategy only rasterizes the glyphs the
 * layout references and turns layout data into instance data.
 *
 * ── GLYPH PIPELINE ──
 * ① Rasterize (CPU Canvas2D, on demand): a glyph's ink box at
 *    `fontSize × band` physical px is drawn into the atlas page bitmap
 *    (`glyphAtlas.ts` — shelf packing, pad margins, Paging + Flush eviction).
 * ② Upload (GPU): dirty atlas pages are DMA'd whole into `r8unorm` page
 *    textures (coverage in `.r` — the engine's mask-channel convention).
 * ③ Draw: one instanced draw per atlas PAGE — one instance per glyph quad
 *    (origin/size from layout × logical px) + one instance per decoration
 *    rect (sampling the reserved white pixel), fragment = coverage × tint,
 *    STRAIGHT alpha, MAX blend (coverage union, same rationale as the stroke
 *    paint pass).
 *
 * ── DENSITY ──
 * `args.density` (export supersampling today; viewport density band in P3) is
 * quantized UP to a density band and the atlas rasterizes at that band. Same
 * band ⇒ on-screen glyph texels ≈ atlas texels (1:1, sharp); lower target
 * density downsamples linearly (acceptable); a higher one cannot happen by
 * construction of the quantization. The interactive path passes density 1
 * this phase; a set rasterized at another band (e.g. a previous export) keeps
 * its own atlas keyed by band.
 *
 * ── SAME-SOURCE SYNC ──
 * Like `StrokeRenderer`, all work happens inside `prepareVectorSources`'s
 * synchronous per-source loop; page uploads are enqueued on the device queue
 * BEFORE the surrounding command buffer is submitted, so draws sample the
 * freshly written pages. Placements are immutable once allocated and pages are
 * never rewritten in place while alive, so a mid-frame upload can never corrupt
 * a region an earlier draw already references.
 *
 * @module core/gpu/graph/build/vectorRenderers/TextRenderer
 */

import { GPUBufferUsage, GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import {
  ATLAS_PAGE_SIZE,
  GlyphAtlasCache,
  quantizeDensityBand,
  type GlyphRasterizer,
  type GlyphRequest,
} from '@opengpex/editor/core/engine/text/glyphAtlas';
import { TEXT_UNIFORM_BUFFER_SIZE, TEXT_INSTANCE_STRIDE } from '@opengpex/editor/core/engine/gpu/shaders/text';
import type { TextParams } from '../../../scene/Scene';
import type { VectorRenderer, VectorRenderContext, VectorRenderArgs } from './VectorRenderer';

/**
 * Capacity of the instance ring (4 MiB ≈ 131k instances of 32 bytes). A text
 * layer's glyph + decoration count is bounded by the document, far below this;
 * `buildInstances` hard-caps at the ring's capacity and drops the overflow
 * rather than wrapping mid-quad.
 */
const TEXT_INSTANCE_RING_CAPACITY = 4 * 1024 * 1024;

/**
 * Canvas2D glyph rasterizer: measures ink boxes and draws glyph coverage into
 * an atlas page's byte array. Ink metrics come from `actualBoundingBox*`
 * (CSS ink extents) with the layout module's fallback ratios when the browser
 * does not expose them. White fill on transparent scratch canvas — the alpha
 * channel IS the coverage.
 */
class CanvasGlyphRasterizer implements GlyphRasterizer {
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  private ensure(width: number, height: number): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
    if (!this.canvas) {
      this.canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(1, 1)
          : document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d') as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
    }
    const canvas = this.canvas!;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return this.ctx!;
  }

  font(fontFamily: string, fontWeight: number, italic: boolean, rasterFontSize: number): string {
    return `${italic ? 'italic' : 'normal'} ${fontWeight} ${rasterFontSize}px ${fontFamily}`;
  }

  measure(
    text: string,
    font: string,
    rasterFontSize: number,
  ): { inkW: number; inkH: number; inkAscent: number; inkLeft: number } {
    const ctx = this.ensure(1, 1);
    ctx.font = font;
    const m = ctx.measureText(text);
    // Ink extents; browsers without actualBoundingBox* fall back to the same
    // ratios textLayout.ts uses for its content-area approximation.
    const ascent = m.actualBoundingBoxAscent ?? rasterFontSize * 0.8;
    const descent = m.actualBoundingBoxDescent ?? rasterFontSize * 0.2;
    const left = m.actualBoundingBoxLeft ?? 0;
    const right = m.actualBoundingBoxRight ?? m.width;
    return {
      inkW: Math.max(1, left + right),
      inkH: Math.max(1, ascent + descent),
      inkAscent: Math.max(0, ascent),
      inkLeft: left,
    };
  }

  /**
   * Draw one glyph's coverage into the page bitmap. `x`/`y` is the ink box's
   * TOP-LEFT inside the page (pad already excluded by the atlas); the cell's
   * ink box extends rightward/downward from it by the measured extents.
   */
  rasterize(
    text: string,
    font: string,
    rasterFontSize: number,
    into: Uint8Array,
    pageSize: number,
    x: number,
    y: number,
  ): void {
    const m = this.measure(text, font, rasterFontSize);
    const w = Math.ceil(m.inkW);
    const h = Math.ceil(m.inkH);
    if (w <= 0 || h <= 0) return;
    const ctx = this.ensure(w, h + rasterFontSize);
    ctx.clearRect(0, 0, w, h + rasterFontSize);
    ctx.font = font;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    // Draw at the pen→ink offset so the scratch canvas's column 0 is the ink's
    // LEFT edge (not the pen origin): glyphs with a left side bearing ink
    // right of the pen would otherwise lose their right edge to the w-wide
    // copy window below.
    ctx.fillText(text, m.inkLeft, rasterFontSize);
    const img = ctx.getImageData(0, 0, w, h + rasterFontSize);
    // Baseline inside the scratch canvas sits at rasterFontSize; the page's ink origin
    // is y (= ink top), so copy rows starting at rasterFontSize - inkAscent.
    const srcTop = Math.max(0, Math.round(rasterFontSize - m.inkAscent));
    const copyH = Math.min(h, img.height - srcTop);
    for (let row = 0; row < copyH; row++) {
      const srcRow = (srcTop + row) * w * 4;
      const dstRow = (y + row) * pageSize + x;
      for (let col = 0; col < w; col++) {
        into[dstRow + col] = img.data[srcRow + col * 4 + 3];
      }
    }
  }
}

/** GPU mirror of one atlas set: its r8unorm page textures plus the per-page
 * GPUTextureView / BindGroup cache. Textures are created once and only ever
 * re-uploaded in place (`writeTexture`), so views are stable for the set's
 * lifetime; bind groups additionally depend on the uniform ring buffer, so
 * they are keyed by that buffer object and rebuilt if it ever changes. The
 * whole GpuSet (and with it both caches) is dropped on cache-generation
 * moves and device changes. */
interface GpuSet {
  textures: GPUTexture[];
  views: (GPUTextureView | null)[];
  bindGroups: Map<GPUBuffer, (GPUBindGroup | null)[]>;
}

function emptyGpuSet(): GpuSet {
  return { textures: [], views: [], bindGroups: new Map() };
}

/** Per-instance instance-buffer data layout (floats), mirrors the WGSL VSInput. */
const INSTANCE_FLOATS = TEXT_INSTANCE_STRIDE / 4;

export class TextRenderer implements VectorRenderer {
  /** Text writes pure coverage/colour; it never reads a composited backdrop. */
  readonly needsBackdrop = false;

  private cache: GlyphAtlasCache | null = null;
  private cacheDevice: GPUDevice | null = null;
  /** GPU page textures per atlas set key; dropped wholesale when the cache generation moves. */
  private gpuSets = new Map<string, GpuSet>();
  /** Last-seen page versions (setKey:pageIndex → version) for dirty tracking. */
  private seenVersions = new Map<string, number>();
  private seenGeneration = 0;
  /** Per-frame flush gate — the opaque token `prepareVectorSources` mints per composite. */
  private lastFrameToken: object | null = null;

  /** Lazily-built instance ring (VERTEX|COPY_DST; rebuilt on device change). */
  private instanceRing: BufferRing | null = null;
  private ringDevice: GPUDevice | null = null;

  /** Rasterizer scratch (Canvas2D), lazy. */
  private rasterizer: CanvasGlyphRasterizer | null = null;

  /** Reused hot-path scratch: per-page instance collectors (page → floats),
   * the packed instance upload buffer, and the per-layer uniform block.
   * Frame-stable to keep the per-layer/per-page draw encoding allocation-free. */
  private scratchPages = new Map<number, number[]>();
  private scratchF32 = new Float32Array(0);
  private uniformScratch = new Float32Array(TEXT_UNIFORM_BUFFER_SIZE / 4);

  private ensureCache(device: GPUDevice): GlyphAtlasCache {
    if (this.cache && this.cacheDevice === device) return this.cache;
    this.cache = new GlyphAtlasCache();
    this.cacheDevice = device;
    this.gpuSets.clear();
    this.seenVersions.clear();
    this.seenGeneration = this.cache.generation;
    return this.cache;
  }

  private ensureRing(device: GPUDevice): BufferRing {
    if (this.instanceRing && this.ringDevice === device) return this.instanceRing;
    this.instanceRing?.destroy();
    this.instanceRing = new BufferRing(
      device,
      TEXT_INSTANCE_RING_CAPACITY,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      'Text Instance Ring',
    );
    this.ringDevice = device;
    return this.instanceRing;
  }

  /**
   * Ensure a GPU texture exists for the given atlas page and upload its pixels
   * when dirty. Pages are immutable once written (only NEW allocations change
   * them), so a whole-page write is always safe mid-frame.
   */
  private syncPage(
    device: GPUDevice,
    setKey: string,
    pageIndex: number,
    data: Uint8Array,
    gpuSet: GpuSet,
  ): void {
    while (gpuSet.textures.length <= pageIndex) {
      gpuSet.textures.push(
        device.createTexture({
          size: [ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE, 1],
          format: 'r8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          label: `Glyph Atlas Page (${setKey} #${gpuSet.textures.length})`,
        }),
      );
    }
    device.queue.writeTexture(
      { texture: gpuSet.textures[pageIndex] },
      data,
      { bytesPerRow: ATLAS_PAGE_SIZE },
      [ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE],
    );
  }

  /**
   * Pack one text layer's layout into per-page instance batches. PURE (no GPU,
   * no DOM) — exported for tests. Returns null when the layer has no drawable
   * content. Instance order within a page batch is stable (lines in order).
   */
  /**
   * Drop the atlas sets rasterized at `band` AND their GPU page mirrors
   * (export path: the export-band atlas is one-shot — rasterize, composite,
   * release). Mirrors `GlyphAtlasCache.evictBand` + the generation-driven
   * texture teardown in `render`.
   */
  releaseBand(band: number): void {
    if (!this.cache) return;
    this.cache.evictBand(band);
    const suffix = `|${band}`;
    for (const [key, set] of this.gpuSets) {
      if (!key.endsWith(suffix)) continue;
      for (const t of set.textures) t.destroy();
      this.gpuSets.delete(key);
      for (const k of this.seenVersions.keys()) {
        if (k.startsWith(`${key}:`)) this.seenVersions.delete(k);
      }
    }
    this.seenGeneration = this.cache.generation;
  }

  render(pass: GPURenderPassEncoder, ctx: VectorRenderContext, args: VectorRenderArgs): void {
    if (args.params.renderer !== 'text') {
      throw new Error(`TextRenderer received non-text params: ${args.params.renderer}`);
    }
    const p: TextParams = args.params.text;
    if (!p.layout.lines.length) return;

    const cache = this.ensureCache(ctx.device);
    // Frame boundary (per composite): apply deferred atlas flushes ONCE, before
    // this frame's requests — the Paging + Flush eviction contract.
    if (this.lastFrameToken !== (args.frameToken ?? null)) {
      this.lastFrameToken = args.frameToken ?? null;
      cache.beginFrame();
    }
    if (cache.generation !== this.seenGeneration) {
      // Atlas was flushed/evicted: drop GPU page mirrors and dirty tracking.
      for (const set of this.gpuSets.values()) {
        for (const t of set.textures) t.destroy();
      }
      this.gpuSets.clear();
      this.seenVersions.clear();
      this.seenGeneration = cache.generation;
    }

    const density = args.density ?? 1;
    const band = quantizeDensityBand(density);
    const setKey = `${p.fontKey}|${band}`;
    const rasterizer = (this.rasterizer ??= new CanvasGlyphRasterizer());

    // Deduped glyph requests for the whole layer.
    const requests: GlyphRequest[] = [];
    const seen = new Set<string>();
    for (const line of p.layout.lines) {
      if (!line.charX) return; // layout without per-char data cannot be GPU-drawn
      for (const ch of Array.from(line.text)) {
        const k = `${ch}\u0000${p.fontSize}`;
        if (!seen.has(k)) {
          seen.add(k);
          requests.push({ char: ch, fontSize: p.fontSize });
        }
      }
    }

    const { placements, decoUV } = cache.request(
      setKey, p.fontKey, band, p.fontFamily, p.fontWeight, p.italic, requests, rasterizer,
    );
    const placementOf = new Map<string, (typeof placements)[number]>();
    for (let i = 0; i < requests.length; i++) {
      placementOf.set(`${requests[i].char}\u0000${requests[i].fontSize}`, placements[i]);
    }

    // Pack instances per page: glyphs first, then decoration rects (white pixel).
    const scratch = this.scratchPages;
    for (const arr of scratch.values()) arr.length = 0;
    const emit = (page: number, vals: number[]) => {
      let arr = scratch.get(page);
      if (!arr) {
        arr = [];
        scratch.set(page, arr);
      }
      for (const v of vals) arr.push(v);
    };

    for (const line of p.layout.lines) {
      const chars = Array.from(line.text);
      const charX = line.charX!;
      for (let i = 0; i < chars.length; i++) {
        const placement = placementOf.get(`${chars[i]}\u0000${p.fontSize}`);
        if (!placement) continue; // missing this frame (flush pending) — skip silently
        emit(placement.page, [
          charX[i] - placement.inkLeft, // origin x (pen position minus pen→ink offset — the cell's column 0 IS the ink's left edge)
          line.baselineY - placement.inkAscent, // origin y (quad top)
          placement.inkW,               // size x
          placement.inkH,               // size y
          placement.u0, placement.v0,   // uv_min
          placement.u1 - placement.u0,  // uv_size
          placement.v1 - placement.v0,
        ]);
      }
    }
    if (decoUV) {
      const decoPage = 0;
      const push = (x: number, y: number, w: number, h: number) => {
        emit(decoPage, [
          x, y, w, h,
          decoUV.u0, decoUV.v0,
          decoUV.u1 - decoUV.u0, decoUV.v1 - decoUV.v0,
        ]);
      };
      for (const r of p.layout.underlines) push(r.x, r.y, r.w, r.h);
      for (const r of p.layout.strikethroughs) push(r.x, r.y, r.w, r.h);
    }
    if (!scratch.size) return;

    // Upload dirty atlas pages BEFORE encoding draws (queue ordering at submit).
    const gpuSet = this.gpuSets.get(setKey) ?? emptyGpuSet();
    this.gpuSets.set(setKey, gpuSet);
    for (const dirty of cache.takeDirtyPages(this.seenVersions)) {
      const target = dirty.setKey === setKey
        ? gpuSet
        : (this.gpuSets.get(dirty.setKey) ?? emptyGpuSet());
      if (target !== gpuSet) this.gpuSets.set(dirty.setKey, target);
      this.syncPage(ctx.device, dirty.setKey, dirty.pageIndex, dirty.data, target);
    }

    // Instance ring + per-page draws.
    const ring = this.ensureRing(ctx.device);
    const instanceCapacity = TEXT_INSTANCE_RING_CAPACITY / TEXT_INSTANCE_STRIDE;
    const uniformData = this.uniformScratch;
    uniformData[0] = p.color[0];
    uniformData[1] = p.color[1];
    uniformData[2] = p.color[2];
    uniformData[3] = p.color[3];
    uniformData[4] = p.width;
    uniformData[5] = p.height;

    pass.setPipeline(ctx.pipelineCache.getTextPipeline(ctx.targetFormat));
    pass.setVertexBuffer(0, ctx.pipelineCache.getQuadVertexBuffer());

    // Per-page GPUTextureView + BindGroup are cached on the GpuSet (textures
    // are write-once-stable, the uniform ring buffer is frame-stable), so a
    // redraw never re-wraps the texture or re-allocates a bind group.
    const uniformBuffer = ctx.bufferRing.getBuffer();
    let cachedBindGroups = gpuSet.bindGroups.get(uniformBuffer);
    if (!cachedBindGroups) {
      cachedBindGroups = [];
      gpuSet.bindGroups.set(uniformBuffer, cachedBindGroups);
    }

    for (const [page, floats] of scratch) {
      if (floats.length / INSTANCE_FLOATS > instanceCapacity) continue; // absurd layer; drop rather than corrupt the ring
      const count = floats.length;
      if (count > this.scratchF32.length) {
        this.scratchF32 = new Float32Array(Math.max(count, 4096));
      }
      const packed = this.scratchF32.subarray(0, count);
      for (let i = 0; i < count; i++) packed[i] = floats[i];
      const slot = ring.writeSlot(packed);
      const slotU = ctx.bufferRing.writeSlot(uniformData);
      let view = gpuSet.views[page];
      if (!view) {
        view = gpuSet.textures[page].createView();
        gpuSet.views[page] = view;
      }
      let bindGroup = cachedBindGroups[page];
      if (!bindGroup) {
        bindGroup = ctx.device.createBindGroup({
          layout: ctx.pipelineCache.getTextBindGroupLayout(),
          label: 'Text Paint BindGroup',
          entries: [
            {
              binding: 0,
              resource: { buffer: uniformBuffer, offset: 0, size: TEXT_UNIFORM_BUFFER_SIZE },
            },
            { binding: 1, resource: view },
            { binding: 2, resource: ctx.pipelineCache.getLinearSampler() },
          ],
        });
        cachedBindGroups[page] = bindGroup;
      }
      pass.setVertexBuffer(1, slot.buffer, slot.offset, slot.size);
      pass.setBindGroup(0, bindGroup, [slotU.offset]);
      pass.draw(6, count / INSTANCE_FLOATS);
    }
  }
}

/** Engine built-in singleton — the GPU text slot. */
export const textRenderer = new TextRenderer();

/**
 * Release the export-band glyph atlas (plan §3.4: the export path rasterizes
 * at `exportScale`'s density band as a ONE-SHOT — composite, then release, so
 * interactive VRAM is untouched by export-scale glyphs). The interactive band
 * (1×) atlas is never affected.
 */
export function releaseExportGlyphAtlas(exportScale: number): void {
  textRenderer.releaseBand(quantizeDensityBand(exportScale));
}
