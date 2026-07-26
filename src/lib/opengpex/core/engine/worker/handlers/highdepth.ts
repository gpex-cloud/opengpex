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
 * HighDepthHandler — Worker-side handler for high-precision (16/32-bit) composite jobs.
 *
 * This handler is the routing target when `CompositeJob.precision >= 16`.
 * It delegates all compositing logic to VipsBackend, which uses wasm-vips
 * to perform float-precision layer compositing.
 *
 * Responsibilities:
 * - Accept CompositeJob from CompositorHandler
 * - Delegate to VipsBackend.compose()
 * - Return PixelResultData with proper depth (16 or 32)
 *
 * Architecture (phase5_highdepth.md §3):
 * - Thin delegation layer (VipsBackend owns the compositing logic)
 * - Same return shape as Canvas2dBackend path for transparent routing
 */

import type { CompositeJob } from '../../protocol/jobs';
import type { PixelResultData } from '../../protocol/results';
import { VipsBackend } from '../../rendering/offscreen/VipsBackend';

export class HighDepthHandler {
  private vipsBackend: VipsBackend;

  constructor() {
    this.vipsBackend = new VipsBackend();
  }

  /**
   * Handle a high-precision composite job.
   *
   * @param job - CompositeJob with precision 16 or 32
   * @returns Result containing the composited TIFF blob at requested precision
   */
  async handle(job: CompositeJob): Promise<{ result: PixelResultData }> {
    const result = await this.vipsBackend.compose(job);
    return { result };
  }
}
