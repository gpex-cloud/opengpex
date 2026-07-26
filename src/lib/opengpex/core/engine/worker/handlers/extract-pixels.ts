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
 * ExtractPixelsHandler — Worker-side handler for EXTRACT_PIXELS jobs.
 *
 * Extracts raw RGBA pixel data from a cached bitmap using OffscreenCanvas.
 * The resulting ArrayBuffer is transferred (zero-copy) back to the main thread.
 *
 * This moves the expensive getImageData() call off the main thread,
 * satisfying Invariant #1: "main thread zero pixel-intensive computation".
 */

import { workerCache } from '../cache/WorkerCache';
import type { ExtractPixelsJob } from '../../protocol/jobs';
import type { RouterResult } from '../router';

export class ExtractPixelsHandler {
  async handle(job: ExtractPixelsJob): Promise<RouterResult> {
    const bitmap = workerCache.getBitmap(job.src);
    if (!bitmap) {
      throw new Error(`[ExtractPixelsHandler] bitmap not found for: ${job.src.slice(0, 32)}…`);
    }

    const { rect } = job;
    const sx = rect?.x ?? 0;
    const sy = rect?.y ?? 0;
    const sw = rect?.w ?? bitmap.width;
    const sh = rect?.h ?? bitmap.height;

    // Clamp to bitmap bounds
    const clampedSw = Math.min(sw, bitmap.width - sx);
    const clampedSh = Math.min(sh, bitmap.height - sy);

    const canvas = new OffscreenCanvas(clampedSw, clampedSh);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, sx, sy, clampedSw, clampedSh, 0, 0, clampedSw, clampedSh);
    const imageData = ctx.getImageData(0, 0, clampedSw, clampedSh);

    // Transfer the underlying ArrayBuffer (zero-copy to main thread)
    const buffer = imageData.data.buffer;
    return {
      result: {
        data: buffer,
        width: clampedSw,
        height: clampedSh,
      },
      transfer: [buffer],
    };
  }
}
