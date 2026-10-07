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
 * results.ts — Unified result data format returned by Worker to main thread.
 *
 * All operations (composite/resample/filter/rasterize) share this shape.
 * The main-thread PixelResult class wraps this data and provides
 * convenience methods (toAsset, toBlob, toImageData).
 */

import type { ColorIdentity, Rect } from '@opengpex/editor/core/types';
import type { HighDepthSource } from '@opengpex/editor/core/engine/sources/HighDepthSource';

/**
 * Worker-produced result payload.
 * Transferred back to main thread via postMessage.
 */
export interface PixelResultData {
  blob: Blob;
  hash: string;
  width: number;
  height: number;
  dprScale?: number;
  depth: 8 | 16 | 32;
  bounds: Rect;
  /**
   * Bake-precision settlement: when a composite produced a 16/32-bit
   * product, this carries the STRAIGHT LINEAR-light naked pixels (half-float) so
   * `PixelResult.toAsset()` can warm `HighDepthTextureCache[assetId]` — the same
   * residency the on-screen preview reads. The `blob` remains an 8-bit sRGB PNG
   * display fallback (shown only if the high-depth cache is ever cold). Absent for
   * ≤8-bit products, which stay on the zero-copy bitmap path (invariant A).
   *
   * ⚠️ In-memory warm happens in `PixelResult.toAsset`; the engine also persists these
   * naked pixels via `assetStore.setRawBuffer` (self-describing `rawbuf:` record),
   * so a cold reload/revert warms the cache directly (bypassing vips). Absent for
   * ≤8-bit products, which stay on the zero-copy bitmap path (invariant A).
   */
  highDepthSource?: HighDepthSource;

  /**
   * Colour identity of the product pixels — the SOLE authority a consumer needs
   * (`core/strategy/bake.ts::resolveBakeColorIdentity` produced the gamut; the
   * dispatcher settled the depth axis against the readback it actually emitted).
   *
   * `PixelResult.toAsset()` forwards it to `assets.inject`, so a baked layer is
   * registered with the gamut its pixels are really in. Without it every bake
   * product fell back to `DEFAULT_COLOR_IDENTITY` (sRGB) regardless of the canvas
   * tag, and `SceneAssembler` then read `gamut:'srgb'` off a P3 asset and had the
   * shader apply a spurious sRGB→P3 lift — the oversaturation on merge/peel
   * products that the composite-side gamut fix alone does NOT remove.
   *
   * Optional: dispatchers producing plain 8-bit sRGB content may omit it.
   */
  colorIdentity?: ColorIdentity;
}
