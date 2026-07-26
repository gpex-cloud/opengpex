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
 * CompositorHandler — Worker-side routing layer for composite jobs.
 *
 * Receives a CompositeJob from the router and dispatches to the appropriate
 * backend based on `precision`:
 * - precision 8     → Canvas2dBackend (Phase 3)
 * - precision 16/32 → HighDepthHandler → VipsBackend (Phase 5)
 *
 * This class exists as a thin routing layer so that backend selection
 * is transparent to the router and dispatch layers.
 */

import type { CompositeJob } from '../../protocol/jobs';
import type { PixelResultData } from '../../protocol/results';
import { Canvas2dBackend } from '../../rendering/offscreen/Canvas2dBackend';
import { HighDepthHandler } from './highdepth';

export class CompositorHandler {
  private canvas2dBackend: Canvas2dBackend;
  private highdepthHandler: HighDepthHandler;

  constructor() {
    this.canvas2dBackend = new Canvas2dBackend();
    this.highdepthHandler = new HighDepthHandler();
  }

  /**
   * Handle a CompositeJob — route to the appropriate backend based on precision.
   *
   * Routing logic (architecture doc §四):
   * - precision >= 16 → VipsBackend (float compositing, TIFF output)
   * - precision  8    → Canvas2dBackend (8-bit compositing, PNG output)
   */
  async handle(job: CompositeJob): Promise<{ result: PixelResultData; transfer?: Transferable[] }> {
    if (job.precision >= 16) {
      return this.highdepthHandler.handle(job);
    }
    const result = await this.canvas2dBackend.compose(job);
    return { result };
  }
}
