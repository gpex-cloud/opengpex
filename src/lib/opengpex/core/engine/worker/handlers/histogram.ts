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
 * Computes a full-resolution RGB composite histogram matching Photoshop's
 * Levels dialog behavior. Unlike a per-pixel luminance histogram, Photoshop's
 * "RGB" composite counts each channel independently:
 *
 *   For each pixel → histR[R]++, histG[G]++, histB[B]++
 *   Display bin[i] = histR[i] + histG[i] + histB[i]
 *
 * This produces a visually different (and more informative) distribution than
 * a single weighted-luminance approach, because it preserves the individual
 * channel peaks rather than collapsing three dimensions into one.
 *
 * The resulting 256-bin Uint32Array is transferred (zero-copy) back to the
 * main thread via the ArrayBuffer transfer mechanism.
 *
 * Performance: A 2000×2000 image (~16M pixel reads) completes in 15–30ms on
 * a modern device. Since this runs in the Worker thread, main-thread frame
 * rate is unaffected.
 */

import { workerCache } from '../cache/WorkerCache';
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

    // Compute RGB composite histogram (Photoshop-style).
    //
    // Photoshop's "RGB" channel in the Levels dialog does NOT compute a
    // per-pixel luminance. Instead, it counts each R, G, B channel value
    // independently and sums them into one composite histogram:
    //
    //   For each opaque pixel:
    //     histR[R]++; histG[G]++; histB[B]++;
    //   composite[i] = histR[i] + histG[i] + histB[i]
    //
    // This preserves the individual channel peaks and produces a histogram
    // shape that matches what Photoshop displays.
    const histR = new Uint32Array(256);
    const histG = new Uint32Array(256);
    const histB = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      // Skip fully-transparent pixels so alpha-padded borders don't
      // artificially inflate the black bin.
      if (data[i + 3] === 0) continue;
      histR[data[i]]++;
      histG[data[i + 1]]++;
      histB[data[i + 2]]++;
    }

    // Sum the three per-channel histograms into the composite.
    const hist = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      hist[i] = histR[i] + histG[i] + histB[i];
    }

    // Transfer the underlying ArrayBuffer (zero-copy to main thread).
    const buffer = hist.buffer;
    return {
      result: { histogram: buffer },
      transfer: [buffer],
    };
  }
}
