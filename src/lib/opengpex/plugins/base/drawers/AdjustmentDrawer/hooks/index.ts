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
 * AdjustmentDrawer hooks — barrel export.
 *
 * Split into focused modules:
 * - useAdjustmentDrawer: drawer state + tool switching
 * - useFilterGesture: gesture-based undo coalescing for filter panels
 * - useLayerHistogram: lazy luminance histogram for Levels panel
 */

export { useAdjustmentDrawer, useGradingToolSwitch } from './useAdjustmentDrawer';
export { useFilterGesture } from './useFilterGesture';
export type { FilterGestureCommand, FilterGestureHandle } from './useFilterGesture';
export { useLayerHistogram } from './useLayerHistogram';
export type { LayerHistogram } from './useLayerHistogram';
