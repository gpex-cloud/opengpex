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
 * CompositeDispatcher — orchestrates internal composite requests from the main
 * thread onto the SINGLE WebGPU RenderGraph.
 *
 * ═══ v2 STATUS: GPU Readback (Worker compositor retired) ═══
 *
 * The previous path (`CompositeDispatcher → WorkerBridge → CompositorHandler →
 * Canvas2dBackend`) is gone: vips/Canvas2D compositing is retired
 * and there is no separate Worker compositor. Internal composites now share the
 * EXACT same GPU pipeline as on-screen preview and unified export — only the
 * final sink differs (readback buffer vs. swapchain).
 *
 * WHAT "INTERNAL COMPOSITE" MEANS HERE (distinct from document export):
 *   This is a *layer-subset → composite bitmap* operation, NOT a full-document
 *   export. It composites ONLY the layers passed in, cropped to their world-space
 *   ROI (usually the layers' bounding union), and returns a **bitmap asset**
 *   (`CompositedImage`) that downstream commands (merge / peel / fragment / clip)
 *   consume via `AssetService.storeBundle()`. No file container, no ICC injection —
 *   that belongs to the export command layer.
 *
 * ONE-PIPELINE EQUIVALENCE (why the subset composite == preview pixels):
 *   We assemble a SYNTHETIC frame whose canvas IS the ROI box, and RIGIDLY SHIFT
 *   the subset layers so the ROI's top-left lands on the canvas origin. A rigid
 *   translation of `cx/cy` changes only WHERE a layer lands, never its pixels.
 *   The synthetic frame reuses the SAME `layer.assetId`s, the SAME
 *   `HighDepthTextureCache`, and the SAME working format the preview warmed, so
 *   `SceneAssembler.syncAssets` dedups by residency and `engine.export`
 *   runs the identical compile + `RenderGraph.composite` path as `render()`.
 *   Hence composite pixels ≡ preview pixels for the same layers.
 *
 * Architecture: facade → CompositeDispatcher → getGpuEngine().export() (readback)
 */

import { getGpuEngine } from '@opengpex/editor/core/engine/pipeline/WebGpuEngine';
import { SceneAssembler } from '@opengpex/editor/core/engine/pipeline/scene/SceneAssembler';
import { highDepthTextureCache } from '@opengpex/editor/core/engine/sources/HighDepthSource';
import type { HighDepthSource, HighDepthFetcher } from '@opengpex/editor/core/engine/sources/HighDepthSource';
import { unpremultiplyEncodeGamut, unpremultiplyEncodeLinearF16 } from '@opengpex/editor/core/engine/utils/export-utils';
import { resampleBilinear } from '@opengpex/editor/core/engine/color/resampleHighDepth';
import { WORKING_GAMUT } from '@opengpex/editor/core/engine/color/gamut';
import { canvasToBlob, toDisplayTrackCanvasColorSpace } from '../utils/pixel-utils';
import type { CompositedImage, SampledPixels } from '../types';
import type { FileService } from '@opengpex/editor/core/files';
import type {
  Layer,
  Frame,
  Rect,
  ColorIdentity,
  GamutId,
  WorkingColorSpace,
  WorldShape,
  AssetService,
  GeometryService,
} from '@opengpex/editor/core/types';
import { asWorldShape } from '@opengpex/editor/core/types';

/**
 * The gamut of the GPU working buffer the readback comes out of.
 *
 * HARD INVARIANT, not a default (see `core/engine/color/gamut.ts::WORKING_GAMUT`):
 * `GpuDevice.configureSurface` configures the swapchain as `display-p3`
 * unconditionally and `resolveSourceGamutId` treats display-p3 as the passthrough
 * id, so every composite readback — whatever the document's gamut — is Linear
 * Display-P3. The terminal encodes below convert FROM here. Reading it from a
 * shared constant (rather than deriving it from the frame) is what makes the
 * sRGB-document case correct: it needs a real P3→sRGB matrix, and the old code's
 * implicit "readback is already in the frame's space" assumption is exactly what
 * shipped P3 numbers under an sRGB tag.
 */

/**
 * Display-track-specific canvas color space mapping — distinct from
 * `core/files/color.ts::toCanvasColorSpace`. That function serves export (egest)
 * scenarios where wide-gamut documents are routed to the 16-bit vips raw-pixel
 * channel by `resolveEgestDecision`, never reaching canvas tagging.
 *
 * The 8-bit displayBlob track here has no such detour: every docGamut (including
 * adobe-rgb / prophoto-rgb / rec2020) unconditionally emits an OffscreenCanvas
 * bitmap. Reusing the egest fallback would clamp all wide gamuts down to sRGB,
 * forfeiting the 'display-p3' option supported by 8-bit canvas that preserves
 * wider gamut boundaries. Hence this separate mapping: only exact 'srgb' falls
 * back to 'srgb'; all other wide gamuts map to 'display-p3'.
 *
 * Shared with `ResampleHandler` (same 8-bit OffscreenCanvas display-track
 * constraint) — see `pixel-utils.ts::toDisplayTrackCanvasColorSpace`.
 */

// ─── Request interface ───

export interface CompositeRequest {
  layers: Layer[];
  /** ROI must be in world-space (branded WorldShape). Use geometry.shape.localToWorldShape() to convert. */
  roi: WorldShape;
  /**
   * Full source frame context. Supplies the document's DPI (inherited by the
   * synthetic ROI sub-frame) and its base asset id (resolves the
   * document-anchored bake gamut) — the caller no longer pre-computes
   * either and passes them in separately.
   */
  frame: Frame;
  /** When specified, the composite is scaled (post-encode canvas scale) to exactly this size. */
  outputSize?: { w: number; h: number };
}


// ─── CompositeDispatcher ───

export class CompositeDispatcher {
  /**
   * `files` is the whole `FileService`; `warmHighDepth` reads `files.recover`
   * as the cold-recovery fetcher for `HighDepthTextureCache.ensure`. Injected at
   * construction by `createPixelFacade`. `undefined` (a test double that omits
   * it) degrades to the pre-existing zero-recovery behaviour, not a throw.
   */
  constructor(
    private geometry: GeometryService,
    private assets: AssetService,
    private files?: FileService,
  ) {}

  /**
   * Best-effort pre-warm: for every non-group layer whose asset claims a
   * `dataFormat`, block until `HighDepthTextureCache` actually holds it (or the
   * recovery attempt failed/found nothing). Without this, the `getHighDepthSource`
   * callback below is a synchronous `.get()` with no chance to fetch, so a cold
   * cache miss would otherwise silently bake the 8-bit fallback into an
   * irreversible merge/peel/fragment product.
   */
  private async warmHighDepth(layers: Layer[]): Promise<void> {
    if (!this.files) return; // never wired (e.g. a test double) — unchanged legacy behaviour
    const recover: HighDepthFetcher = (id) => this.files!.recover(id);
    await Promise.all(
      layers
        .filter((l) => l.type !== 'group' && this.assets.get(l.assetId)?.dataFormat)
        .map((l) => highDepthTextureCache.ensure(l.assetId, recover)),
    );
  }

  /**
   * Shared GPU-readback core for {@link composite} and {@link capture} — the ONE
   * path that turns a layer subset + world ROI into a premultiplied LINEAR f32
   * readback plus the arbitrated document identity. Both callers diverge only in
   * the TERMINAL encode (8-bit blob bake vs. f32/8-bit in-memory capture); keeping
   * the synthetic-frame build + assemble + export + gamut arbitration here means
   * the two can never drift.
   *
   * 1. Build a synthetic ROI-sized frame with the subset layers rigidly shifted.
   * 2. `SceneAssembler.buildScene` + `syncAssets` (reuses resident textures).
   * 3. `engine.export({ bitDepth: 32 })` → premultiplied LINEAR RGBA readback.
   * 4. Arbitrate the document's OWN baseline gamut/bit-depth (via
   *    `frame.assetId` → `StoredAsset`), never inflated by a participating layer.
   */
  private async renderReadback(
    layers: Layer[],
    roi: WorldShape,
    frame: Frame,
    /**
     * Snapshot texels per world pixel. Omitted (bake/export) = `1`, i.e. 1:1
     * document pixels. Below 1 the readback is DOWNSAMPLED by the same composite
     * pass that draws the viewport, so a texel is a filtered display texel, not a
     * document pixel — the caller must record the factor and scale its indexing.
     */
    scale = 1,
  ): Promise<{
    fpixels: Float32Array;
    width: number;
    height: number;
    docGamut: GamutId;
    docBitDepth: ColorIdentity['bitDepth'];
    roiRect: Rect;
    /** The world rect ACTUALLY covered: `roiRect` with its size ceil'd to whole
     *  pixels (the synthetic canvas is integral). This — not `roiRect` — is what a
     *  caller must publish as its snapshot's world bounds. */
    coveredRect: Rect;
  }> {
    await this.warmHighDepth(layers);

    const roiRect = roi.rect;
    const roiW = Math.max(1, Math.ceil(roiRect.w));
    const roiH = Math.max(1, Math.ceil(roiRect.h));

    // ── 1. Synthetic subset frame (ROI box as canvas, layers shifted to origin) ──
    // Rigid shift: worldPoint (X,Y) → canvas (X - roiRect.x, Y - roiRect.y).
    // getLayerLocalMatrix adds `+canvas.w/2` (= roiW/2); subtracting it here makes
    // the two terms cancel, so the ceil() rounding of roiW/roiH never perturbs
    // placement. See ONE-PIPELINE EQUIVALENCE note above.
    const Dx = -roiRect.x - roiW / 2;
    const Dy = -roiRect.y - roiH / 2;

    const byId: Record<string, Layer> = {};
    const order: string[] = [];
    for (const layer of layers) {
      // Groups carry no pixels; SceneAssembler skips them anyway.
      if (layer.type === 'group') continue;
      const shifted: Layer = {
        ...layer,
        cx: layer.cx + Dx,
        cy: layer.cy + Dy,
        // The caller hand-picked this subset — force it composited regardless of
        // the layer's own visibility / hidden-group membership.
        visible: true,
        groupId: undefined,
      };
      byId[shifted.id] = shifted;
      order.push(shifted.id);
    }

    // The synthetic frame carries NO colour fields. Per-asset colour
    // truth lives on `StoredAsset` (`SceneAssembler` resolves each layer's source
    // gamut from `assets.get(layer.assetId).gamut`), and the working buffer is
    // always Linear Display-P3 — so there is nothing left for a frame-level
    // `colorSpace`/`bitDepth` to say. The bake target gamut applies at the terminal
    // ENCODE (in the caller), not during assembly.
    const synthFrame = {
      id: '__composite_subset__',
      name: 'composite-subset',
      canvas: { w: roiW, h: roiH },
      dpi: frame.dpi ?? 72, // inherit the real source frame's DPI
      camera: { x: 0, y: 0, k: 1 },
      layers: { byId, order },
      activeLayerId: null,
    } as unknown as Frame;

    // ── 2. Assemble + upload on the SAME engine the preview uses ──
    const engine = getGpuEngine();
    const { scene, uploads, lutUploads } = SceneAssembler.buildScene({
      frame: synthFrame,
      camera: synthFrame.camera,
      viewportDim: { w: roiW, h: roiH },
      // Fixed 1:1 — document-space bake, not a screen-DPR-scaled preview.
      dpr: 1,
      geometry: this.geometry,
      assets: this.assets,
      getHighDepthSource: (assetId: string) => highDepthTextureCache.get(assetId) ?? undefined,
    });
    SceneAssembler.syncAssets(uploads, engine, lutUploads);

    // ── 3. Readback (premultiplied LINEAR RGBA). ALWAYS f32 (a superset). ──
    const exported = await engine.export(scene, {
      bitDepth: 32,
      ...(scale !== 1 ? { scale } : {}),
    });
    const fpixels = exported.pixels as Float32Array;

    // ── 4. Self-adaptive gamut/bit-depth from the document's own identity ──
    const docAsset = frame.assetId ? this.assets.get(frame.assetId) : undefined;
    const docGamut: GamutId = docAsset?.gamut ?? 'srgb';
    const docBitDepth: ColorIdentity['bitDepth'] = docAsset?.bitDepth ?? 8;

    return {
      fpixels,
      width: exported.width,
      height: exported.height,
      docGamut,
      docBitDepth,
      roiRect,
      coveredRect: { x: roiRect.x, y: roiRect.y, w: roiW, h: roiH } as Rect,
    };
  }

  /**
   * Composite a layer subset on the GPU and read it back as a bitmap asset.
   *
   * Shares `renderReadback()` with {@link capture}; this method owns the BAKE
   * terminal: dual-track encode (8-bit display blob + optional high-depth naked
   * pixels) wrapped as a persistable `CompositedImage`. Bake semantics/product
   * are unchanged by the extraction.
   */
  async composite(request: CompositeRequest): Promise<CompositedImage> {
    const { fpixels, width, height, docGamut, docBitDepth, roiRect } =
      await this.renderReadback(request.layers, request.roi, request.frame);

    const hasHighDepth = docBitDepth > 8 || !!(request.frame.assetId ? this.assets.get(request.frame.assetId)?.dataFormat : undefined);
    // `colorSpaceToGamut` never yields 'rec2020' today (no ingest path produces
    // it), so every reachable `docGamut` already has a WorkingColorSpace-typed
    // conversion matrix — this cast reflects that, it is not a runtime clamp.
    const docGamutForEncode = docGamut as WorkingColorSpace;
    // 8-bit display track: clamp to what an OffscreenCanvas can actually tag.
    const canvasColorSpace = toDisplayTrackCanvasColorSpace(docGamut);

    // ── Terminal un-premultiply encode (single encode point) ──
    // 8-bit display bitmap: clamped canvas-representable gamut (Display track).
    const encoded = unpremultiplyEncodeGamut(fpixels, width, height, {
      sourceGamut: WORKING_GAMUT,
      targetGamut: canvasColorSpace,
      bitDepth: 8,
    }) as Uint8ClampedArray;

    // 16-bit high-depth naked pixels (High-Depth track): the document's own
    // UNCLAMPED physical gamut, zero truncation — only when the document's
    // own baseline identity is high-depth.
    let highDepthSource: HighDepthSource | undefined;
    if (hasHighDepth) {
      const nativeHalf = unpremultiplyEncodeLinearF16(fpixels, width, height, {
        sourceGamut: WORKING_GAMUT,
        targetGamut: docGamutForEncode,
      });
      if (request.outputSize) {
        const outW = Math.max(1, Math.round(request.outputSize.w));
        const outH = Math.max(1, Math.round(request.outputSize.h));
        highDepthSource = {
          data: resampleBilinear(nativeHalf, width, height, outW, outH),
          width: outW,
          height: outH,
          dataFormat: 'rgba16float',
          trc: 'linear',
        };
      } else {
        highDepthSource = {
          data: nativeHalf,
          width,
          height,
          dataFormat: 'rgba16float',
          // The half-float pixels are STRAIGHT LINEAR light: tag 'linear' so
          // SceneAssembler skips the sRGB→linear decode when this asset is sampled.
          trc: 'linear',
        };
      }
    }

    // Land the straight target-gamut pixels on a canvas tagged with the SAME gamut
    // (no implicit browser conversion) for the asset bitmap.
    const composed = new OffscreenCanvas(width, height);
    const cctx = composed.getContext('2d', { colorSpace: canvasColorSpace })!;
    const imgData = cctx.createImageData(width, height, { colorSpace: canvasColorSpace });
    imgData.data.set(encoded);
    cctx.putImageData(imgData, 0, 0);

    // Optional scale (post-encode canvas scale — `export()` is native-size only).
    let outCanvas = composed;
    let outW = width;
    let outH = height;
    if (request.outputSize) {
      outW = Math.max(1, Math.round(request.outputSize.w));
      outH = Math.max(1, Math.round(request.outputSize.h));
      outCanvas = new OffscreenCanvas(outW, outH);
      const octx = outCanvas.getContext('2d', { colorSpace: canvasColorSpace })!;
      octx.drawImage(composed, 0, 0, width, height, 0, 0, outW, outH);
    }

    // ── Wrap as a plain-data CompositedImage ──
    const displayBlob = await canvasToBlob(outCanvas);

    const colorIdentity: ColorIdentity = {
      gamut: docGamut,
      trc: hasHighDepth ? 'linear' : 'srgb-trc',
      bitDepth: docBitDepth,
      dataFormat: hasHighDepth ? 'rgba16float' : undefined,
    };

    return {
      displayBlob,
      width: outW,
      height: outH,
      colorIdentity,
      highDepthSource,
      bounds: { x: roiRect.x, y: roiRect.y, w: outW, h: outH } as Rect,
    };
  }

  /**
   * Lightweight PURE-MEMORY pixel capture — the sampler/mosaic
   * hot path. Shares `renderReadback()` with {@link composite} but SKIPS
   * `canvasToBlob`/`blobToImageData` AND the terminal encode entirely: it returns
   * the raw premultiplied-linear working-gamut readback. No persistence, no ICC,
   * no bake semantics.
   *
   * THE TERMINAL ENCODE IS THE CALLER'S, VIA `sampleGpuRawData()`. Encoding
   * both tracks here over the whole ROI measured 1.3s of main-thread `Math.pow`
   * on a 4096×4096 snapshot — 85% of the capture — to serve an eyedropper that
   * reads a 5×5 window (25 texels) per mouse move. See
   * `engine/utils/sample-utils.ts`.
   *
   * @param frame The document frame (supplies `assetId` for gamut arbitration).
   * @param opts.roi    World-space coverage region. Defaults to the full artboard.
   * @param opts.layers Layer subset to composite. Defaults to all visible, non-group,
   *                    non-host layers (mirrors `render.compositeFrame`). Passing a
   *                    single layer yields "current layer" sampling.
   * @param opts.scale  Snapshot texels per world pixel (default 1 = document
   *                    pixels). Pass `min(1, camera.k)` to snapshot at DISPLAY
   *                    resolution: coverage then equals the viewport at any zoom
   *                    for a viewport-sized cost, at the price of sampling
   *                    filtered display texels. Recorded on the result as
   *                    `scale` — index with it.
   */
  async capture(
    frame: Frame,
    opts?: { roi?: WorldShape; layers?: Layer[]; scale?: number },
  ): Promise<SampledPixels> {
    const layers = opts?.layers ?? frame.layers.order
      .map((id) => frame.layers.byId[id])
      .filter((l) => !l.hostId && l.visible !== false && l.type !== 'group');

    const roi: WorldShape = opts?.roi
      ?? asWorldShape({ x: -frame.canvas.w / 2, y: -frame.canvas.h / 2, w: frame.canvas.w, h: frame.canvas.h });

    const scale = opts?.scale && opts.scale > 0 ? Math.min(1, opts.scale) : 1;

    const { fpixels, width, height, docGamut, coveredRect } =
      await this.renderReadback(layers, roi, frame, scale);

    return {
      linearPixels: fpixels,
      width,
      height,
      // WORLD-space coverage, straight from the composite's own integral canvas.
      // `width`/`height` are TEXELS (`≈ covered × scale`), so the two only coincide
      // at scale 1 — index through `sampleGpuRawData`, never by subtraction alone.
      bounds: coveredRect,
      scale,
      gamut: docGamut,
    };
  }
}
