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
 * BgRemover Store — Module-level store instance via createAIToolStore factory.
 *
 * Single source of truth for the bgremover feature's runtime state.
 * Uses the generic AIToolStore factory for subscribe/notify/busySync logic.
 *
 * Consumers use `bgRemoverStore.setState(...)`, `.reset()`, `.subscribe(...)`,
 * `.getState()`, and `.initBusySync(...)` directly.
 *
 * @see _shared/createAIToolStore.ts
 */

import { createAIToolStore } from '../_shared/control/createAIToolStore';
import type { LocalPolygon } from '@opengpex/editor/core/types';

// ─── BgRemover-specific Result Type ──────────────────────────────────────────

export interface BgRemoverResult {
  deviceUsed: 'webgpu' | 'wasm';
  inferenceMs: number;
  postProcessMs: number;
  totalMs: number;
  vertexCount: number;
  /** Stored polygon reference for re-apply (e.g. clicking "Foreground Mask" again) */
  polygon: LocalPolygon;
  frameId: string;
}

// ─── Store Instance ──────────────────────────────────────────────────────────

export const bgRemoverStore = createAIToolStore<BgRemoverResult>();
