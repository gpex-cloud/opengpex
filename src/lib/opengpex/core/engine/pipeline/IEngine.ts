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
 * IEngine.ts — the declarative v2 render-engine contract + its data types.
 *
 * Extracted from WebGpuEngine.ts so the
 * pipeline layer (SceneAssembler / adjustments / SceneContentCache) depends on
 * the CONTRACT via an intra-layer import rather than reaching upward. The class
 * now lives alongside this contract in `core/engine/pipeline/WebGpuEngine.ts`
 * and re-exports these types for backward compatibility.
 *
 * @module core/engine/pipeline/IEngine
 */

import type { Capabilities } from '@opengpex/editor/core/engine/gpu/device/Capabilities';
import type { SurfaceConfig } from '@opengpex/editor/core/engine/gpu/device/GpuDevice';
import type { GpuInfo } from '@opengpex/editor/core/engine/gpu/GpuInfo';
import type { Scene } from './scene/Scene';
import type { Lut3dUpload } from './scene/lut3dPlan';
import type { GamutId } from '@opengpex/editor/core/types';

// ────────────────────────────────────────────────────────────
// Export contract
// ────────────────────────────────────────────────────────────

/**
 * Export request options.
 *
 * The v2 promise: export shares the SAME compiled RenderGraph as the on-screen
 * frame, so 16-bit output is no longer a separate vips composite path — only
 * the final sink differs. vips is retained for codec duties only.
 */
export interface ExportOptions {
  /** Output bit depth. 16/32 require a float working format. */
  readonly bitDepth: 8 | 16 | 32;
  /** Optional crop in world pixels; defaults to the artboard. */
  readonly region?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** Scale factor applied to the output resolution. */
  readonly scale?: number;
  /** Explicit target export width (takes precedence over scale) */
  readonly targetWidth?: number;
  /** Explicit target export height (takes precedence over scale) */
  readonly targetHeight?: number;
  /**
   * Desired output gamut. The readback itself is UNCHANGED —
   * it stays premultiplied LINEAR light in the ENGINE's working gamut
   * (`core/engine/color/gamut.ts::WORKING_GAMUT` — always Linear Display-P3, never
   * derived from the document); the source→target gamut
   * matrix + target TRC are applied CPU-side by `unpremultiplyEncodeGamut` after
   * this readback. This field documents export intent and reserves a future GPU
   * hook to fuse the conversion into the readback pass; `export()` currently just
   * threads it through without altering pixels.
   */
  readonly targetGamut?: GamutId;
}

/** Raw readback result, ready to hand to a codec. */
export interface ExportResult {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: 8 | 16 | 32;
  /** Interleaved RGBA pixels at the requested depth. */
  readonly pixels: Uint8ClampedArray | Uint16Array | Float32Array;
}

// ────────────────────────────────────────────────────────────
// Upload source
// ────────────────────────────────────────────────────────────

/**
 * Discriminated union of ingested source pixels. The source bit depth
 * DETERMINISTICALLY selects the resident texture format —
 * callers never pick precision:
 *   • 8-bit sources → `bitmap` (zero-copy `copyExternalImageToTexture` →
 *     `rgba8unorm`); no VRAM waste, no needless f16 fattening. `gamut` tags the
 *     source's intrinsic gamut (= frame.colorSpace) so the copy is an identity
 *     (no P3→sRGB narrowing) and the shader aligns gamut_id→working.
 *   • 8-bit MASK sources → `bitmap` + `channel: 'r'` (`r8unorm`, 1 byte/pixel —
 *     a 4× VRAM saving over `rgba8unorm` per record). Bitmap masks keep their
 *     coverage in the ALPHA channel on the CPU (alpha compositing is how eraser
 *     strokes accumulate); the engine remaps α→R at upload time, so the
 *     SAMPLING side must read `.r` — the ONE bmask channel convention on the
 *     GPU (see `bmaskCombine.ts`).
 *   • 16/32-bit sources → `raw` (vips/wasm-decoded naked pixels via
 *     `writeTexture` → `rgba16float`/`rgba32float`).
 *
 * The composite working buffer stays `rgba16float` regardless.
 */
export type UploadSource =
  | {
    kind: 'bitmap';
    data: ImageBitmap | VideoFrame | OffscreenCanvas;
    gamut?: GamutId;
    /**
     * Single-channel upload: the source is a bitmap MASK whose coverage lives
     * in the alpha channel; the resident texture is `r8unorm` with the alpha
     * remapped into R. Omit for color rasters (`rgba8unorm`).
     */
    channel?: 'r';
  }
  | {
    kind: 'raw';
    data: Float32Array | Uint16Array;
    desc: { w: number; h: number; format: 'rgba16float' | 'rgba32float' };
  };

// ────────────────────────────────────────────────────────────
// 1D LUT upload (curves/levels)
// ────────────────────────────────────────────────────────────

/**
 * A resident 1D LUT for the curves/levels adjustment path. `data` is a
 * half-float (IEEE binary16) RGBA table of `width` entries — R/G/B hold the
 * per-channel tone mapping (levels replicates one table across all channels;
 * curves bakes `perChannel(master(x))`), A is unused. The engine dedups by
 * `lutId`: a deterministic content-hash id means an identical curve/level
 * config resolves to ONE resident texture and re-uploading is a no-op.
 */
export interface LutUpload {
  readonly lutId: string;
  /** RGBA half-float, 4 × `width` u16s (see color/float16). */
  readonly data: Uint16Array;
  readonly width: number;
}

// ────────────────────────────────────────────────────────────
// IEngine
// ────────────────────────────────────────────────────────────

/**
 * The declarative render engine contract.
 *
 * Design notes:
 *   • No implicit ordering — every method is independently callable.
 *   • `render` is synchronous and fire-and-forget; batching / dirty-region
 *     culling are internal concerns, not caller obligations.
 *   • Asset lifecycle is explicit (`uploadSource` / `release`) so textures stay
 *     resident in VRAM instead of being copied across threads each frame.
 */
export interface IEngine {
  /** Initialize device/context/pools. Idempotent. Returns negotiated capabilities. */
  init(canvas: HTMLCanvasElement, surface?: SurfaceConfig): Promise<Capabilities>;

  /** Synchronously attach a new or remounted canvas to the existing device surface. */
  attachCanvas(canvas: HTMLCanvasElement, surface?: SurfaceConfig): boolean;

  /** Declaratively render one frame to the swapchain. */
  render(scene: Scene): void;

  /**
   * Register a ONE-SHOT callback fired after the NEXT successful frame is
   * actually submitted to the swapchain (i.e. real pixels exist).
   *
   * WHY (see Viewport visibility gate): the stage container fades in on
   * `isReady`. Gating that on "bitmap decoded" (`imagesLoaded`) is wrong — a
   * decoded bitmap is NOT the same milestone as "the GPU has drawn this frame".
   * The checkerboard (synchronous SVG) would fade in the instant a bitmap
   * lands, while the WebGPU canvas still waits for the next ticker tick to
   * `render()`, so the board flashes ahead of the image. This callback lets the
   * gate wait for the true first paint instead. Returns an unsubscribe fn.
   */
  onFirstPaint(cb: () => void): () => void;

  /** Render the same Scene to an offscreen target and read it back (export). */
  export(scene: Scene, opts: ExportOptions): Promise<ExportResult>;

  /**
   * Is this asset already resident in VRAM? SceneAssembler MUST query this
   * before uploading, so pan/zoom frames skip re-transfer entirely.
   */
  has(assetId: string): boolean;

  /**
   * Upload/update a resident GPUTexture from an ingested source.
   *
   * The source bit depth deterministically selects the resident texture format
   * (precision invariant): `bitmap` → `rgba8unorm` (zero-copy), or `r8unorm`
   * when `channel: 'r'` (bitmap masks — alpha remapped into R), `raw` →
   * `rgba16float`/`rgba32float`. Callers never pick precision.
   *
   * Dedup contract: if `assetId` is already resident and unchanged, this
   * is a no-op — no release/create/DMA. "Unchanged" means either the optional
   * `version` stamp matches the resident one, or (when no version is given) the
   * `src.data` reference is identical to the resident source. Only a genuine
   * pixel change (draw/erase/filter → new source or bumped version) re-transfers.
   */
  uploadSource(assetId: string, src: UploadSource, version?: number): void;

  /**
   * Upload/dedup a resident 1D LUT texture for curves/levels. If
   * `lutId` is already resident this is a no-op (deterministic content id ⇒ same
   * pixels), so calling it every frame is zero-transfer. See {@link LutUpload}.
   */
  uploadLut(lut: LutUpload): void;

  /** Is this LUT already resident? (dedup contract mirror of {@link has}.) */
  hasLut(lutId: string): boolean;

  /**
   * Upload/dedup a resident 3D `.cube` LUT texture. Same dedup
   * contract as {@link uploadLut}. The plan's `format` is capability-adapted by
   * `lut3dPlan.selectLut3dFormat` — the engine just uploads what it is given.
   */
  uploadLut3d(lut: Lut3dUpload): void;

  /** Is this 3D LUT already resident? */
  hasLut3d(lutId: string): boolean;

  /** Release a resident 3D LUT texture. */
  releaseLut3d(lutId: string): void;

  /** Release a resident LUT texture. */
  releaseLut(lutId: string): void;

  /** Release a resident texture. */
  release(assetId: string): void;

  /** True once a device has been negotiated and is ready. */
  isReady(): boolean;

  /**
   * Synchronous GPU diagnostics snapshot: adapter identity +
   * allocation-ceiling limits + engine memory book-keeping (pool stats + the
   * engine-owned composite target's footprint). Returns `{ ready:false, … }`
   * with placeholder statics before the device is negotiated.
   *
   * ⚠️ See {@link GpuInfo}: `limits` are allocation ceilings and `memory` is the
   * engine's own accounting — NEITHER is a real hardware-VRAM figure (WebGPU
   * exposes no such API).
   */
  getGpuInfo(): GpuInfo;

  destroy(): void;
}
