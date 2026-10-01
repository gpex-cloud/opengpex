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
 * ExportDispatcher — orchestrates the unified WebGPU document export (readback →
 * terminal gamut encode) that used to live inline in
 * `ImageInfoDrawer/commands.ts` (symmetric to
 * `CompositeDispatcher` per Decision B1).
 *
 * WHAT THIS IS (distinct from `CompositeDispatcher`'s internal composite):
 *   This is a *full-document → encodable pixel source* operation for EXPORT TO
 *   AN EXTERNAL FILE. It renders the frame exactly as the on-screen preview
 *   would, at the caller-resolved export dimensions/region, and returns an
 *   `EncodeSource` ready for `FileService.encode()`. The egest colour/channel
 *   decision itself (`resolveEgestDecision`) stays the caller's responsibility —
 *   this dispatcher only consumes the already-resolved fields it needs.
 *
 * ONE PIPELINE EQUIVALENCE (moved verbatim from `commands.ts`, do not summarize):
 *   The composite is derived ONLY from the camera-INDEPENDENT half of the Scene
 *   (`computeCompositeSignature` excludes `view`). We rebuild from the SAME
 *   `frame` (same `layer.assetId` set, same working format `caps.workingFormat`)
 *   and the SAME high-depth source cache the preview uses; `syncAssets` →
 *   `uploadSource` dedups by assetId/ref, so already-resident preview
 *   textures are reused with zero re-transfer / re-decode. `export()` runs the
 *   identical compile + `RenderGraph.composite` path as `render()` and never
 *   touches the view/present pass, so passing `frame.camera`/`dpr:1` cannot
 *   perturb the composited pixels. Hence export pixels ≡ preview pixels.
 *
 * Architecture: facade → ExportDispatcher → getGpuEngine().export() (readback)
 */

import { getGpuEngine } from '@opengpex/editor/core/engine/pipeline/WebGpuEngine';
import { SceneAssembler } from '@opengpex/editor/core/engine/pipeline/scene/SceneAssembler';
import { highDepthTextureCache } from '@opengpex/editor/core/engine/sources/HighDepthSource';
import type { HighDepthFetcher } from '@opengpex/editor/core/engine/sources/HighDepthSource';
import { unpremultiplyEncodeGamut } from '@opengpex/editor/core/engine/utils/export-utils';
import { WORKING_GAMUT } from '@opengpex/editor/core/engine/color/gamut';
import type { EncodeSource, FileService } from '@opengpex/editor/core/files';
import type {
  Frame,
  Layer,
  Rect,
  Dimensions,
  GamutId,
  AssetService,
  GeometryService,
} from '@opengpex/editor/core/types';

// ─── Request interface ───

export interface ExportRequest {
  /** Full source frame — same frame the on-screen preview is currently rendering. */
  frame: Frame;
  /** Viewport dimensions, mirrored from `ctx.state.ui.viewportDim` (camera-independent, ignored by export). */
  viewportDim: Dimensions;
  /** Target export pixel dimensions (post clip/resize resolution, `calcFinalDims`). */
  targetWidth: number;
  targetHeight: number;
  /** Optional crop region (world/local rect), from an active clip-box selection. */
  region?: Rect;
  /**
   * The gamut the pixels are ACTUALLY encoded into — `egest.targetGamut` (the
   * container-clamped one, not the raw user intent).
   */
  targetGamut: GamutId;
  /** Physical encode lane — `egest.channel`. */
  channel: 'canvas-8' | 'raw-8' | 'raw-16';
  /** Canvas `colorSpace` tag for the `'canvas-8'` lane — `egest.canvasColorSpace`. */
  canvasColorSpace: PredefinedColorSpace;
}

// ─── ExportDispatcher ───

export class ExportDispatcher {
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
   * `dataFormat` (the light record's persisted "a dec: truth exists"
   * predicate — the same one `FileService.recover` tier-1 keys off), block
   * until `HighDepthTextureCache` actually holds it (or the recovery attempt
   * failed/found nothing). Without this, the `getHighDepthSource` callback
   * below is a synchronous `.get()` with no chance to fetch, so a cold cache
   * miss would otherwise silently fall back to the 8-bit path.
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
   * Render the frame on the SAME WebGPU pipeline the preview uses and produce
   * an `EncodeSource` ready for `FileService.encode()`.
   */
  async export(request: ExportRequest): Promise<EncodeSource> {
    const { frame, viewportDim, targetWidth, targetHeight, region, targetGamut, channel, canvasColorSpace } = request;

    await this.warmHighDepth(frame.layers.order.map((id) => frame.layers.byId[id]));

    // ═══ Unified WebGPU export (Readback → encode) ═══════════════════════
    // ONE PIPELINE EQUIVALENCE (why re-assembling here matches preview):
    // The composite is derived ONLY from the camera-INDEPENDENT half of
    // the Scene (`computeCompositeSignature` excludes `view`). We rebuild
    // from the SAME `activeFrame` (same `layer.assetId` set, same working
    // format `caps.workingFormat`) and the SAME high-depth source cache
    // the preview uses; `syncAssets`→`uploadSource` dedups by assetId/ref,
    // so already-resident preview textures are reused with zero
    // re-transfer / re-decode. `export()` runs the identical compile +
    // `RenderGraph.composite` path as `render()` and never touches the
    // view/present pass, so passing `frame.camera`/`dpr:1` cannot perturb
    // the composited pixels. Hence export pixels ≡ preview pixels.
    const engine = getGpuEngine();
    const { scene, uploads, lutUploads } = SceneAssembler.buildScene({
      frame,
      camera: frame.camera,
      viewportDim,
      dpr: 1,
      geometry: this.geometry,
      assets: this.assets,
      // Mirror CanvasStage's per-layer precision seam: a resident 16/32-bit
      // source composites at full precision. `warmHighDepth` above already
      // blocked on `ensure()` for every high-depth-truth layer, so this plain
      // `.get()` is a guaranteed hit for them; a genuine 8-bit source still
      // reads undefined and takes the 8-bit bitmap path (unchanged).
      getHighDepthSource: (assetId: string) => highDepthTextureCache.get(assetId) ?? undefined,
    });
    SceneAssembler.syncAssets(uploads, engine, lutUploads);

    // export() directly renders at target dimensions (and crop region) on WebGPU.
    // Request f32 so the terminal un-premultiply + TRC encode happen in float.
    const exported = await engine.export(scene, {
      bitDepth: 32,
      targetWidth,
      targetHeight,
      region,
      targetGamut,
    });

    // ═══ Terminal gamut encode ═══════════════════════════════════════════
    // ONE float-domain step: un-premultiply → source→target gamut matrix →
    // target TRC → quantize. Downstream encoders do ZERO color math.
    // The lane (`egest.channel`) was settled by the decision:
    //   'raw-16' = naked Uint16Array straight to vips (16-bit),
    //   'raw-8'  = naked Uint8Array straight to vips (8-bit wide gamut),
    //   'canvas-8' = gamut-tagged canvas → ImageBitmap (8-bit srgb/P3).
    // `sourceGamut` is the engine invariant `WORKING_GAMUT` — GPU readback is
    // always premultiplied linear working-space f32, so it is a constant here
    // and deliberately NOT a field on `ExportRequest`.
    let encodeSource: EncodeSource;

    if (channel === 'raw-16') {
      const encoded16 = unpremultiplyEncodeGamut(
        exported.pixels as Float32Array,
        exported.width,
        exported.height,
        { sourceGamut: WORKING_GAMUT, targetGamut, bitDepth: 16 },
      ) as Uint16Array;
      encodeSource = {
        width: exported.width,
        height: exported.height,
        data: encoded16,
        bitDepth: 16,
        colorSpace: targetGamut,
      };
    } else if (channel === 'raw-8') {
      // 8-bit wide-gamut lane: naked Uint8Array straight to the vips PNG/TIFF
      // encoder, NO canvas hop (a canvas would reinterpret adobe-rgb/prophoto-rgb
      // numbers as sRGB/P3). Same RawPixelSource shape as raw-16, bitDepth 8.
      const encoded8 = unpremultiplyEncodeGamut(
        exported.pixels as Float32Array,
        exported.width,
        exported.height,
        { sourceGamut: WORKING_GAMUT, targetGamut, bitDepth: 8 },
      ) as Uint8ClampedArray;
      encodeSource = {
        width: exported.width,
        height: exported.height,
        data: new Uint8Array(encoded8.buffer, encoded8.byteOffset, encoded8.byteLength),
        bitDepth: 8,
        colorSpace: targetGamut,
      };
    } else {
      const encoded8 = unpremultiplyEncodeGamut(
        exported.pixels as Float32Array,
        exported.width,
        exported.height,
        { sourceGamut: WORKING_GAMUT, targetGamut, bitDepth: 8 },
      ) as Uint8ClampedArray;

      // `canvasColorSpace` is derived from the SAME `targetGamut`
      // the matrix above targeted, so the tag can never contradict the
      // pixels (wide-gamut targets never reach this lane — the decision
      // routed them to 'raw-8' or 'raw-16').
      const outCanvas = new OffscreenCanvas(exported.width, exported.height);
      const outCtx = outCanvas.getContext('2d', { colorSpace: canvasColorSpace })!;
      const imgData = outCtx.createImageData(exported.width, exported.height, { colorSpace: canvasColorSpace });
      imgData.data.set(encoded8);
      outCtx.putImageData(imgData, 0, 0);

      encodeSource = await createImageBitmap(outCanvas);
    }



    return encodeSource;
  }
}
