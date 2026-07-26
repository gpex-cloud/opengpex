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
 * engine/filters — Public surface for filter algorithms and pixel utilities.
 *
 * Consumers: plugins/base/drawers/AdjustmentDrawer/ (levels, curves, useFilterGesture)
 *            plugins/base/overlays/BrushOverlay/stroke/bake.ts
 *
 * Provides:
 *   - Pure algorithm functions (LUT generators) for plugin UI panels
 *   - Pixel utility functions (content bounds calculation)
 *   - filterCache reference for UI gesture coordination (setDragging)
 *
 * ISOMORPHISM NOTE: The underlying filter2d.ts is shared between main thread
 * and Worker. This barrel only re-exports the subset needed by plugin UI code.
 */

// ── LUT Generators (for Adjustment panel sliders) ──
export { generateLevelsLUT, generateCurveLUT } from './rendering/shared/filter2d';

// ── Pixel Utilities (for bake/content-bounds operations) ──
export { calculateContentBoundsFromImageData } from './utils/pixel-utils';

// ── Filter Cache (for gesture coordination — setDragging/subscribe) ──
export { filterCache } from './cache/FilterCache';
