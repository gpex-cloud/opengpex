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
 * DecoderHandler — Worker-side handler for DECODE jobs.
 *
 * Adapted from v1 `worker/handlers/explorer.ts`:
 * - Renamed from `explorer` to `decoder` to match v2 nomenclature.
 * - Accepts typed `DecodeJob` (instead of ad-hoc params).
 * - Returns structured results compatible with RouterResult.
 * - Stores decoded blob in WorkerCache for future use by other handlers.
 *
 * Fetch → decode → store in WorkerCache → transfer bitmap back.
 */

import type { DecodeJob } from '../../protocol/jobs';
import { workerCache } from '../cache/WorkerCache';
import { calculateHash } from '../../utils/pixel-utils';
import type { RouterResult } from '../router';

export class DecoderHandler {
  /**
   * Handle a DECODE job dispatched by the router.
   *
   * Fetch, decode, cache in WorkerCache, and transfer bitmap to main thread.
   * The transferred bitmap is zero-copy (ownership moves to main thread).
   */
  async handle(job: DecodeJob): Promise<RouterResult> {
    const response = await fetch(job.src);
    if (!response.ok) {
      throw new Error(`[DecoderHandler] Fetch failed for ${job.src}: HTTP ${response.status}`);
    }
    const blob = await response.blob();

    // Store blob+bitmap in Worker-side cache for future use (e.g., by ResampleHandler)
    const hash = await calculateHash(blob);
    await workerCache.ingest(hash, blob);

    // Decode bitmap with default browser color management so wide-gamut sources
    // (Display-P3, etc.) retain their embedded ICC tags when transferred to main thread.
    const bitmap = await createImageBitmap(blob, {
      imageOrientation: 'from-image',
    });

    try {
      const cvs = new OffscreenCanvas(1, 1);
      const ctx = cvs.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1, 0, 0, 1, 1);
      const px = ctx.getImageData(0, 0, 1, 1).data;
      console.log('[ColorProfile-Debug][Worker-DecoderHandler]', {
        src: job.src.slice(0, 32),
        width: bitmap.width,
        height: bitmap.height,
        colorSpaceConversion: 'default',
        centerPixel: [px[0], px[1], px[2], px[3]],
      });
    } catch {
      // ignore
    }

    return {
      result: { bitmap },
      transfer: [bitmap],
    };
  }
}
