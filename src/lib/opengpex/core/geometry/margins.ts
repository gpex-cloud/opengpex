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
 * margins.ts — the single home for rasterization AA margin constants.
 *
 * WHY IT EXISTS: every renderer family leaks a known, bounded amount of
 * coverage beyond its analytic geometry, and several unrelated modules
 * quantify that leak into integer pixel pads. Before this module the same
 * "1px AA margin" lived as independent literals (LayerFactory.AA_MARGIN,
 * ClipOverlay's inline `1 + featherPad`, the mosaic bake worker's bare ±1),
 * so any change to an AA strategy would silently desynchronize them. Every
 * pad that exists to contain AA bleed must be derived here.
 *
 * Semantics (per renderer family):
 * - stroke ribbon (brush): coverage is exactly zero at the radius — leak 0,
 *   NO AA pad is warranted anywhere.
 * - face / SDF / selection rasterization (vmask): the smoothstep AA band
 *   reaches ~half a pixel beyond the edge — leak ~0.5px, quantized to
 *   AA_MARGIN = 1 whole pixel.
 * - culling and sub-mask windows use their own performance-oriented
 *   clearances (CULL_PADDING, the vmask window margin) and intentionally
 *   stay where they are: those are performance postures, not fidelity
 *   guarantees, and must not silently track the fidelity constant.
 *
 * @module core/geometry/margins
 */

/**
 * Integer quantization of the ~0.5px AA coverage bleed shared by the
 * face/SDF/vmask/selection rasterizer families. Always a whole pixel; pads
 * built on it keep windows on the integer lattice.
 */
export const AA_MARGIN = 1;

/**
 * The pad a window needs to fully contain a feathered soft band: the
 * band's coverage reaches zero only at distance `feather` beyond the cut
 * contour, plus the AA margin for the rasterizer's own bleed. Always round
 * UP — under-padding clips the soft edge, over-padding only costs texels.
 * `feather = 0` deliberately still yields AA_MARGIN (the pure AA posture);
 * callers that want NO pad at all for hard edges guard on their own
 * feather value, mirroring the canonical feathered-fragment form.
 */
export function featherPad(feather: number): number {
  return Math.ceil(feather) + AA_MARGIN;
}
