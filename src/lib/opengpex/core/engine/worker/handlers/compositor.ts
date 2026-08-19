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
 * CompositorHandler — Worker-side handler for composite jobs.
 *
 * Receives a CompositeJob from the router and dispatches to Canvas2dBackend.
 * All composite operations run at 8-bit precision via Canvas2dBackend.
 *
 * WebGPU upgrade path: replace Canvas2dBackend → WebGpuBackend (single swap).
 */

import type { CompositeJob } from '../../protocol/jobs';
import type { PixelResultData } from '../../protocol/results';
import { Canvas2dBackend } from '../../rendering/offscreen/Canvas2dBackend';

export class CompositorHandler {
  private canvas2dBackend: Canvas2dBackend;

  constructor() {
    this.canvas2dBackend = new Canvas2dBackend();
  }

  /**
   * Handle a CompositeJob — always routes to Canvas2dBackend (8-bit).
   */
  async handle(job: CompositeJob): Promise<{ result: PixelResultData; transfer?: Transferable[] }> {
    const result = await this.canvas2dBackend.compose(job);
    return { result };
  }
}
