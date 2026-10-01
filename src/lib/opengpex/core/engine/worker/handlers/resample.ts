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
 * ResampleHandler — Worker-side handler for RESAMPLE jobs.
 *
 * Adapted from v1 `worker/handlers/transformer.ts` (resampleImage function):
 * - Accepts typed `ResampleJob` instead of ad-hoc parameters.
 * - Returns unified `PixelResultData` format.
 * - Uses high-quality bicubic interpolation (`imageSmoothingQuality: 'high'`).
 * - Computes hash for the result blob.
 *
 * Flow: fetch source → decode → resample via OffscreenCanvas → encode → wrap result.
 */

import type { ResampleJob } from '../../protocol/jobs';
import type { PixelResultData } from '../../protocol/results';
import { calculateHash, canvasToBlob, toDisplayTrackCanvasColorSpace } from '../../utils/pixel-utils';
import type { RouterResult } from '../router';

export class ResampleHandler {
  /**
   * Handle a RESAMPLE job dispatched by the router.
   */
  async handle(job: ResampleJob): Promise<RouterResult> {
    const { src, targetWidth, targetHeight, sourceGamut = 'srgb' } = job;

    // 1. Fetch and decode source bitmap
    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`[ResampleHandler] Fetch failed for ${src}: HTTP ${response.status}`);
    }
    const srcBlob = await response.blob();
    const srcBitmap = await createImageBitmap(srcBlob);

    // 2. Resample via OffscreenCanvas with high-quality bicubic interpolation.
    // colorSpace MUST match the source's gamut — otherwise Canvas2D silently
    // clamps wide-gamut (Adobe RGB / ProPhoto RGB / Display P3) sources to sRGB.
    // Uses the display-track mapping (adobe-rgb/prophoto-rgb/rec2020 -> display-p3),
    // NOT files/color.ts::toCanvasColorSpace (that one clamps everything to srgb —
    // it serves the egest/export path, which routes wide gamuts around canvas
    // tagging entirely; this 8-bit resample output has no such detour).
    const colorSpace = toDisplayTrackCanvasColorSpace(sourceGamut);
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d', { colorSpace })!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcBitmap, 0, 0, targetWidth, targetHeight);
    srcBitmap.close();

    // 3. Encode output to blob
    const blob = await canvasToBlob(canvas);

    // 4. Compute content hash
    const hash = await calculateHash(blob);

    // 5. Return unified PixelResultData. Canvas2D output is always 8-bit
    // srgb-trc (no native high-depth/linear-light path) — only the gamut varies.
    const result: PixelResultData = {
      blob,
      hash,
      width: targetWidth,
      height: targetHeight,
      depth: 8,
      bounds: { x: 0, y: 0, w: targetWidth, h: targetHeight },
      colorIdentity: { gamut: sourceGamut, trc: 'srgb-trc', bitDepth: 8 },
    };

    return { result };
  }
}
