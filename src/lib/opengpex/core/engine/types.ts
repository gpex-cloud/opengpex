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
 * engine/types — Type-only exports for cross-module type references.
 *
 * Consumers: core/types/services.ts (PixelService interface definition)
 *
 * This barrel exists to resolve the reverse dependency where core/types/
 * needs engine result/request types for the PixelService interface definition.
 * All exports are `type`-only — zero runtime cost.
 */

import type { ImageAssetPayload } from '../storage/asset/AssetStore';
import type { Rect, GamutId } from '../types/primitives';

export type { CompositeRequest } from './dispatch/CompositeDispatcher';
export type { PixelResultData } from './protocol/results';
export type { GpuInfo } from './gpu/GpuInfo';

/**
 * SampledPixels — the plain-data product of `CompositeDispatcher.capture()`,
 * the pure-memory hot path for the WebGPU colour sampler and mosaic.
 * Unlike `CompositedImage` it carries NO `displayBlob`: capture skips
 * `canvasToBlob`/`blobToImageData` entirely.
 *
 * DELIBERATELY UN-ENCODED (the terminal encode is LAZY). This used to carry both
 * finished tracks — an `unpremultiplyEncodeGamutF32` f32 buffer and an 8-bit
 * `ImageData` — encoded eagerly over the WHOLE ROI. Measured on a 4096×4096
 * snapshot that was 663ms + 636ms of main-thread `Math.pow`, 85% of a 1.5s
 * capture, to serve an eyedropper that reads a 5×5 window (25 texels) per mouse
 * move. Both passes now run per-sample through `sampleGpuRawData()` on that
 * 5×5 block instead. The encode math is untouched (same single encode
 * point, same `exportEncode` helpers, same golden contract
 * `round(float*255) === rgb8`) — only WHEN and over HOW MANY pixels it runs
 * changed.
 */
export interface SampledPixels {
  /**
   * RAW readback: PREMULTIPLIED LINEAR-light RGBA in `WORKING_GAMUT`
   * (`width*height*4` floats), exactly as `engine.export({bitDepth: 32})`
   * produced it. NOT display-ready and NOT the document's gamut — read it only
   * through `sampleGpuRawData()` (engine/utils/sample-utils.ts), which owns the
   * un-premultiply → gamut matrix → TRC encode this buffer still needs.
   */
  readonly linearPixels: Float32Array;
  /** Snapshot buffer width/height in TEXELS (= `bounds` × {@link scale}). */
  readonly width: number;
  readonly height: number;
  /** Coverage origin + size in document WORLD space (for pointer inverse-projection index). */
  readonly bounds: Rect;
  /**
   * Snapshot texels per world (document) pixel. `1` means the classic 1:1
   * snapshot, where a texel IS a document pixel.
   *
   * Below 1 the snapshot was composited at DISPLAY resolution: it covers the
   * whole visible region for the cost of the viewport rather than the cost of
   * the document, which is what stops the cursor from ever walking off the
   * coverage and triggering a re-capture. The trade is that a texel is then a
   * GPU-filtered display texel — the colour you SEE — not a document pixel.
   * Callers that need the document's own pixel re-capture that one spot at 1:1
   * (see `ColorSampler`'s commit path).
   *
   * Index accordingly: `floor((worldX - bounds.x) * scale)`.
   */
  readonly scale: number;
  /** Authoritative document gamut (arbitrated via `frame.assetId`). */
  readonly gamut: GamutId;
}

/**
 * CompositedImage — the plain-data product of `CompositeDispatcher.composite()`.
 * Replaces the OOP `CompositeResult` wrapper: callers pass this straight
 * into `AssetService.storeBundle()`, which computes its own content hash — no
 * `hash`/`toAsset()`/`toBlob()` methods needed on the value itself.
 */
export interface CompositedImage extends ImageAssetPayload {
  readonly bounds: Rect;
}

/**
 * ResampledImage — the plain-data product of `ImageDispatcher.resample()`.
 * Replaces the OOP `ResampleResult` wrapper: callers pass this straight into
 * `AssetService.storeBundle()`, or read displayBlob / dimensions directly.
 */
export interface ResampledImage extends ImageAssetPayload {
  readonly bounds: Rect;
  readonly dimensions: { readonly w: number; readonly h: number };
}

/**
 * RasterizedImage — the plain-data product of `RasterizeDispatcher.layer()`.
 * Replaces the OOP `RasterizeResult` wrapper.
 */
export interface RasterizedImage extends ImageAssetPayload {
  readonly bounds: Rect;
}
