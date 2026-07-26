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
 * FilterHandler — Worker-side handler for FILTER jobs.
 *
 * Phase 6.9 refactor:
 * - Source bitmap is now received directly via transfer (ImageBitmap in job.source)
 *   instead of resolving from WorkerCache by hash.
 * - The backend closes the transferred source after processing.
 * - Result bitmap is transferred back to the main thread zero-copy.
 *
 * Architecture:
 *   router → FilterHandler → Canvas2dFilterBackend → shared/filter2d
 */

import type { FilterJob } from '../../protocol/jobs';
import type { RouterResult } from '../router';
import { Canvas2dFilterBackend } from '../../rendering/offscreen/Canvas2dFilterBackend';

// ─── FilterHandler ───

export class FilterHandler {
  private canvas2dBackend = new Canvas2dFilterBackend();

  /**
   * Handle a FILTER job.
   *
   * The job carries an owned ImageBitmap (transferred from main thread).
   * The backend processes it and returns a new filtered bitmap for transfer back.
   */
  async handle(job: FilterJob): Promise<RouterResult> {
    const { source, descriptors, key } = job;

    const result = await this.canvas2dBackend.apply(source, descriptors, key);

    return {
      result: { bitmap: result.bitmap, key: result.key },
      transfer: [result.bitmap],
    };
  }
}
