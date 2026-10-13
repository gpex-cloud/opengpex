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
 * HistogramHandler — Worker-side handler for HISTOGRAM jobs.
 *
 * Computes the five full-resolution layer histograms (r / g / b / luma /
 * composite) matching Photoshop's Levels dialog behavior. The "RGB" composite
 * counts each channel independently rather than collapsing to a weighted
 * luminance — this preserves the individual channel peaks:
 *
 *   For each opaque pixel → histR[R]++, histG[G]++, histB[B]++
 *   composite[i] = histR[i] + histG[i] + histB[i]
 *
 * The counting math and the packed 5 × 256 × 4 B wire format live in
 * `core/engine/color/histograms.ts` (single source of truth, shared with the
 * main-thread facade that unpacks the segments). This handler only wires the
 * WorkerCache bitmap → OffscreenCanvas pixels → packed buffer → transfer.
 *
 * Performance: A 2000×2000 image (~16M pixel reads) completes in 15–30ms on
 * a modern device. Since this runs in the Worker thread, main-thread frame
 * rate is unaffected.
 */

import { workerCache } from '../cache/WorkerCache';
import { countLayerHistograms, packLayerHistogramBuffer } from '@opengpex/editor/core/engine/color/histograms';
import type { HistogramJob } from '../../protocol/jobs';
import type { RouterResult } from '../router';

export class HistogramHandler {
  async handle(job: HistogramJob): Promise<RouterResult> {
    const bitmap = workerCache.getBitmap(job.src);
    if (!bitmap) {
      throw new Error(
        `[HistogramHandler] bitmap not found for: ${job.src.slice(0, 32)}…`,
      );
    }

    const { width, height } = bitmap;

    // Draw the full-resolution bitmap to an OffscreenCanvas to extract pixel data.
    // No downsampling — we iterate every pixel for an accurate histogram.
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('[HistogramHandler] Failed to acquire 2d context');
    }
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);

    const histogramBuffer = packLayerHistogramBuffer(countLayerHistograms(data));
    return {
      result: { histogramBuffer },
      transfer: [histogramBuffer],
    };
  }
}
