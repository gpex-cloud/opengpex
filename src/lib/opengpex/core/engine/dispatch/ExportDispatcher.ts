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
import { unpremultiplyEncodeLinearF16, unpremultiplyEncodeGamut, unpremultiplyEncodePq10, unpremultiplyLinearF32 } from '@opengpex/editor/core/engine/utils/export-utils';
import { applyGainToF32, quantizeGainMapPair } from '@opengpex/editor/core/engine/color/gainMap';
import { WORKING_GAMUT } from '@opengpex/editor/core/engine/color/gamut';
import type { EncodeSource, FileService, GainMapData } from '@opengpex/editor/core/files';
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
  channel: 'canvas-8' | 'raw-8' | 'raw-10' | 'raw-16' | 'exr-half';
  /** Canvas `colorSpace` tag for the `'canvas-8'` lane — `egest.canvasColorSpace`. */
  canvasColorSpace: PredefinedColorSpace;
  /**
   * Per-document HDR presentation switch (WYSIWYG): `false` = the HDR
   * lanes (exr-half) ship the white-clamped SDR rendition the panel showed;
   * `true`/undefined = full scene-referred headroom.
   */
  hdrSemantics?: boolean;
  /**
   * UltraHDR lane input: the document source's decoded gain map (the caller
   * fetches it via `FileService.decodeGainMap` — this dispatcher owns the GPU
   * and the math, not the file read). Present + the `'canvas-8'` lane + a
   * quantizable (SDR, HDR) pair → the result carries `gainMap` to assemble
   * beside the base JPEG; absent, or a pair with no ratio information → the
   * plain lane answers (an honest non-gain-map file). Every other channel
   * ignores it.
   */
  readonly sourceGainMap?: GainMapData | null;
}

/** The unified export result: the encode source every lane produces, plus the
 * gain map when the UltraHDR lane fired (its presence IS the caller's signal
 * to assemble the container — no separate mode field). */
export interface ExportResultSource {
  readonly encodeSource: EncodeSource;
  readonly gainMap?: GainMapData;
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
   * The camera-independent composite readback shared by every export lane:
   * scene assembly + one f32 readback at the target dimensions. See the ONE
   * PIPELINE EQUIVALENCE note in `export` for why this matches the preview.
   */
  private async renderComposite(
    frame: Frame,
    viewportDim: Dimensions,
    targetWidth: number,
    targetHeight: number,
    region: Rect | undefined,
    targetGamut: GamutId,
  ): Promise<{ pixels: Float32Array; width: number; height: number }> {
    await this.warmHighDepth(frame.layers.order.map((id) => frame.layers.byId[id]));
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
    return { pixels: exported.pixels as Float32Array, width: exported.width, height: exported.height };
  }

  /**
   * The canvas-8 terminal lane (un-premultiply → target gamut matrix + TRC →
   * quantize → gamut-tagged canvas → ImageBitmap), factored so the plain
   * export and the UltraHDR base share ONE encode (the assembled file's base
   * must be pixel-identical to what a plain JPEG export would ship).
   */
  private async encodeCanvas8(
    pixels: Float32Array,
    width: number,
    height: number,
    targetGamut: GamutId,
    canvasColorSpace: PredefinedColorSpace,
  ): Promise<EncodeSource> {
    const encoded8 = unpremultiplyEncodeGamut(
      pixels,
      width,
      height,
      { sourceGamut: WORKING_GAMUT, targetGamut, bitDepth: 8 },
    ) as Uint8ClampedArray;
    // `canvasColorSpace` is derived from the SAME `targetGamut`
    // the matrix above targeted, so the tag can never contradict the
    // pixels (wide-gamut targets never reach this lane — the decision
    // routed them to 'raw-8' or 'raw-16').
    const outCanvas = new OffscreenCanvas(width, height);
    const outCtx = outCanvas.getContext('2d', { colorSpace: canvasColorSpace })!;
    const imgData = outCtx.createImageData(width, height, { colorSpace: canvasColorSpace });
    imgData.data.set(encoded8);
    outCtx.putImageData(imgData, 0, 0);
    return createImageBitmap(outCanvas);
  }

  /**
   * The UltraHDR gain derivation, run on the SHARED composite readback: the
   * HDR rendition is rebuilt through the source map (straight linear →
   * `hdr = sdr·2^gain`) and the ratio is quantized against the REAL base
   * pixels, so an edited document exports a map that matches its own pixels
   * rather than parroting the source's. Null when the pair carries no ratio
   * information (an all-black composite) — the caller then ships an honest
   * plain JPEG.
   */
  private quantizeExportGainMap(
    exported: { pixels: Float32Array; width: number; height: number },
    sourceGainMap: GainMapData,
  ): GainMapData | null {
    // Straight (un-premultiplied) linear working-space pixels — the domain the
    // gain math lives in (`hdr = sdr·2^gain` is a linear-light statement).
    const straight = unpremultiplyLinearF32(exported.pixels, exported.width, exported.height);
    const hdr = applyGainToF32(straight, exported.width, exported.height, sourceGainMap);
    return quantizeGainMapPair(straight, hdr, exported.width, exported.height);
  }

  /**
   * Render the frame on the SAME WebGPU pipeline the preview uses and produce
   * the unified export result (`ExportResultSource`).
   */
  async export(request: ExportRequest): Promise<ExportResultSource> {
    const { frame, viewportDim, targetWidth, targetHeight, region, targetGamut, channel, canvasColorSpace } = request;

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
    // view/present pass, so passing `frame.camera`/`dpr:1` cannot
    // perturb the composited pixels. Hence export pixels ≡ preview pixels.
    const exported = await this.renderComposite(frame, viewportDim, targetWidth, targetHeight, region, targetGamut);

    // ═══ UltraHDR lane attempt (canvas-8 only) ═══════════════════════════
    // A gain-map lane of the same readback the plain lanes share: the base is
    // the SDR composite verbatim (a gain-map document's master IS its SDR
    // base — the gain is a presentation adjunct, never baked). A null pair
    // quantization falls through to the plain lane below.
    if (channel === 'canvas-8' && request.sourceGainMap) {
      const gainMap = this.quantizeExportGainMap(exported, request.sourceGainMap);
      if (gainMap) {
        return {
          encodeSource: await this.encodeCanvas8(exported.pixels, exported.width, exported.height, targetGamut, canvasColorSpace),
          gainMap,
        };
      }
    }

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

    if (channel === 'exr-half') {
      // HDR scene-referred lane: STRAIGHT LINEAR half bit patterns, unclamped
      // (the scene-referred contract — `unpremultiplyEncodeLinearF16` only
      // clamps alpha; RGB keeps the full headroom). The gamut matrix targets
      // the SAME gamut the EXR `chromaticities` attribute will declare, so
      // colour truth and tag cannot diverge. No TRC anywhere — the container
      // is definitionally linear.
      if (targetGamut === 'rec2020') {
        // The capability table never admits rec2020 for EXR; a request that
        // reached here is a solver/handler mismatch and must fail loudly.
        throw new Error('[exr] rec2020 target has no conversion matrix');
      }
      const half = unpremultiplyEncodeLinearF16(
        exported.pixels,
        exported.width,
        exported.height,
        { sourceGamut: WORKING_GAMUT, targetGamut },
        // WYSIWYG: switch OFF → the white-clamped SDR rendition.
        request.hdrSemantics === false,
      );
      encodeSource = {
        width: exported.width,
        height: exported.height,
        data: half,
        bitDepth: 16,
        colorSpace: targetGamut,
      };
    } else if (channel === 'raw-10') {
      // HDR AVIF PQ lane (egest's HDR early rule is the ONLY router onto it):
      // straight BT.2020-primary PQ code values at 10 bits, un-premultiplied,
      // headroom preserved. The CICP marker (nclx 9/16/9) is patched onto the
      // encoded file by the AVIF handler — pixels and marker cannot diverge.
      if (request.hdrSemantics !== true) {
        // Unreachable through resolveEgestDecision; a request here is a
        // caller/decision mismatch and must fail loudly (exr guard style).
        throw new Error('[raw-10] PQ lane requires the document HDR switch ON');
      }
      const encoded10 = unpremultiplyEncodePq10(exported.pixels, exported.width, exported.height);
      encodeSource = {
        width: exported.width,
        height: exported.height,
        data: encoded10,
        bitDepth: 10,
        colorSpace: targetGamut,
      };
    } else if (channel === 'raw-16') {
      const encoded16 = unpremultiplyEncodeGamut(
        exported.pixels,
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
        exported.pixels,
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
      encodeSource = await this.encodeCanvas8(exported.pixels, exported.width, exported.height, targetGamut, canvasColorSpace);
    }

    return { encodeSource };
  }
}
