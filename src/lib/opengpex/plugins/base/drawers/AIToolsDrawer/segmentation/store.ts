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
 * Segmentation Store — Module-level store instance via createAIToolStore factory.
 *
 * Single source of truth for the segmentation feature's runtime state.
 * Uses the generic AIToolStore factory for subscribe/notify/busySync logic.
 *
 * Consumers use `segStore.setState(...)`, `.reset()`, `.subscribe(...)`,
 * `.getState()`, and `.initBusySync(...)` directly.
 *
 * @see shared/createAIToolStore.ts
 */

import { createAIToolStore } from '../_shared/control/createAIToolStore';
import type { LocalPolygon } from '@opengpex/editor/core/types';

// ─── Segmentation-specific Result Type ───────────────────────────────────────

export interface SegResult {
  /** Up to N candidate masks sorted by score descending */
  candidates: Array<{
    rings: { x: number; y: number }[][];
    score: number;
  }>;
  /** Index of the currently active candidate in clipBoxes */
  activeCandidateIdx: number;
  /** Performance stats from last decode (ms) */
  lastDecodeMs: number;
  /** Frame ID associated with the current SAM results */
  samFrameId: string;
  /** Pre-projected frame-local polygons (one per candidate) */
  candidateFramePolygons: LocalPolygon[];
}

// ─── Store Instance ──────────────────────────────────────────────────────────

export const segStore = createAIToolStore<SegResult>();
