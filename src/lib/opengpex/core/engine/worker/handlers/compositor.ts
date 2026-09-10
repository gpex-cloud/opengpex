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
 * ═══ v2 STATUS: STUB (spec §13.3 / §15) ═══
 *
 * `Canvas2dBackend` — 597 lines of Worker-side 8-bit software compositing — has
 * been DELETED. It was the export/merge counterpart to the on-screen
 * legacy 2D engine, and carried all the debt that implies: manual
 * `globalCompositeOperation` layering, `composeLinear()`'s ~50-200ms-per-4K-frame
 * per-pixel linear-light blend, `bakeFilters()` CPU filter baking, and
 * ArrayBuffer pixel shuttling across the thread boundary (§2.3, §2.4).
 *
 * v2 replacement: there is no separate Worker compositor at all. `render()` and
 * `export()` share ONE RenderGraph on the GPU; only the final sink differs —
 * swapchain vs. readback buffer (§1.2, §3.2). vips is retained for codecs only.
 *
 * Until the Phase 4 Readback path lands (§11), COMPOSITE jobs fail loudly. That
 * is deliberate: a silent blank-buffer return would corrupt merged layers and
 * exports without anyone noticing. Affected callers (all main-thread) are
 * `pixels.composite()` / `pixels.render.compositeLayers()` → layer merge, layer
 * peel, fragment extraction, clip tool, AI/Comfy bridge drawers, frame import.
 * They keep working in the v1.x LTS build; in v2 they come back online with
 * Readback.
 */

import type { CompositeJob } from '../../protocol/jobs';
import type { PixelResultData } from '../../protocol/results';

export class CompositorHandler {
  /**
   * Handle a CompositeJob.
   *
   * STUB — rejects until the GPU export pipeline exists (Phase 4, §11).
   */
  async handle(_job: CompositeJob): Promise<{ result: PixelResultData; transfer?: Transferable[] }> {
    throw new Error(
      '[CompositorHandler] Canvas2D compositing has been removed in v2. ' +
        'GPU composite + Readback lands in Phase 4 (spec §11).',
    );
  }
}

