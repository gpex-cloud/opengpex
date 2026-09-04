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
 * Volatile fast-track — cohesive module (single sole entry point).
 *
 * The Volatile fast-track is the zero-latency override channel for 60/120fps
 * interactions (drag / brush / viewport roaming write into `volatileRef` without
 * triggering React re-renders or Undo snapshots; the commit lands in Redux only
 * on release). Its full implementation lives here, layered as:
 *
 *   - Producer  (useVolatileState.ts) — owns volatileRef + atomic handles
 *   - Merge/SSOT (merge.ts)           — the single "volatile draft + state → latest" fusion
 *   - Consumer  (useFastSync.ts)      — per-frame ticker hooks that drive overlays
 *
 * The `facade` (actions.fast.*) is assembled inside `useEditorStore` via
 * `createFastFacade`.
 */

export { useVolatileState, INITIAL_VOLATILE } from './useVolatileState';
export { createFastFacade } from './facade';
export type { FastFacadeDeps } from './facade';
export {
  getCompositeKey,
  mergeLayerDraft,
  mergeFrameDraft,
  mergeCamera,
  mergeFrameSnapshot,
} from './merge';
export {
  useFastSync,
  useFastRectSync,
  useFastAnchorSync,
  useFastMatrixSync,
  useFastSvgGroupSync,
  useFastMarchingAntsSync,
} from './useFastSync';
export type { MatrixRect } from './useFastSync';
export type { VolatileState, VolatileInteraction, VolatileStateHandle } from './types';
