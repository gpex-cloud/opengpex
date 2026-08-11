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
 * Upscaler Store — Module-level store instance via createAIToolStore factory.
 *
 * Single source of truth for the upscaler feature's runtime state.
 * Uses the generic AIToolStore factory for subscribe/notify/busySync logic.
 *
 * Consumers use `upscaleStore.setState(...)`, `.reset()`, `.subscribe(...)`,
 * `.getState()`, and `.initBusySync(...)` directly.
 *
 * @see shared/createAIToolStore.ts
 */

import { createAIToolStore } from '../_shared/control/createAIToolStore';

// ─── Upscaler-specific Result Type ──────────────────────────────────────────

export interface UpscaleResult {
  deviceUsed: 'webgpu' | 'wasm';
  inferenceMs: number;
  totalMs: number;
  scaleFactor: number;
  outputWidth: number;
  outputHeight: number;
  frameId: string;
}

// ─── Store Instance ──────────────────────────────────────────────────────────

export const upscaleStore = createAIToolStore<UpscaleResult>();
