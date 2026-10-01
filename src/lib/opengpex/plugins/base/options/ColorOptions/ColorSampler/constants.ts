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
 * Marks interactive chrome that must stay USABLE while the sampler is up —
 * currently the sampler's own tool strip (ColorOptions).
 *
 * The sampler is a modal overlay: it eats every left `mousedown` in the capture
 * phase (a press starts a pick) and hides the system cursor over the document
 * image. Both are correct for the canvas and fatal for a floating toolbar —
 * without an explicit hole, the strip is unclickable AND invisible to the
 * pointer. Put this attribute on the strip's root element and the overlay will:
 *   1. let mousedown / contextmenu through to it,
 *   2. restore a real cursor inside its subtree,
 *   3. hide the crosshair, capsule and hint while the pointer is over it.
 */
export const SAMPLER_CHROME_ATTR = "data-sampler-chrome";

/**
 * Set by the overlay on the viewport container WHILE THE POINTER IS OVER THE
 * DOCUMENT IMAGE (not the surrounding pasteboard). Image and pasteboard share one
 * WebGPU canvas with no DOM boundary, so a JS hit-test drives this attribute and a
 * scoped CSS rule hides the system cursor only here — off-image the normal system
 * cursor stays, and only over the image does it become the eyedropper crosshair.
 */
export const SAMPLER_PICK_ATTR = "data-sampler-pick";

/**
 * Magnifier grid lines — a TWO-TONE (double-stroke) hairline whose two greys
 * are derived from the 5×5 block itself.
 *
 * Why not a fixed colour: the old single `rgba(0,0,0,0.1)` overlay vanished on
 * dark pixels, exactly where counting cells matters most (a near-black photo
 * region read as one blob). Why not per-cell contrast ink either: dividers then
 * changed shade cell by cell, which reads as noise rather than as a grid.
 *
 * Instead each divider is two device pixels: one of `lo`, one of `hi`, where
 * `lo`/`hi` bracket the block's own luminance range by {@link GRID_LINE_MARGIN}.
 * Whatever a divider happens to sit next to, that pixel is inside
 * `[minLum, maxLum]`, so it is at least one margin away from `lo` or from `hi`
 * — one of the two strokes is always visible. Uniform across the grid, so the
 * lines still read as one structure.
 *
 * WIDTH is specified in DEVICE pixels, not CSS pixels: two tones need two
 * physical pixels, and on a 2× display that is a 1px CSS hairline. Hardcoding
 * 2px CSS would double that — visibly heavy against a 20px cell.
 *
 * Cost: one min/max pass folded into the existing sample loop (25 comparisons),
 * two strings per sample, and 2×(n−1) = 8 absolutely-positioned divs. Nothing
 * per frame.
 */
export const GRID_LINE_MARGIN = 48;

/** Divider thickness in DEVICE pixels — one per tone. */
export const GRID_LINE_DEVICE_PX = 2;

/**
 * The four crosshair ticks of the eyedropper reticle, in a 40×40 viewBox centred
 * at (20, 20). Each tick is short and stands off the centre by a 7px gap, so the
 * target pixel and its immediate neighbours stay visible.
 *
 * Defined once and stroked TWICE by the {@link Crosshair} — a wide dark halo
 * underneath, a thin white line on top — which is what makes the reticle legible
 * on any background (the old version drew both strokes at the same width/position,
 * so it just darkened rather than haloing and washed out over light pixels).
 */
export const RETICLE_TICKS: ReadonlyArray<{ x1: number; y1: number; x2: number; y2: number }> = [
  { x1: 7, y1: 20, x2: 13, y2: 20 },  // left
  { x1: 27, y1: 20, x2: 33, y2: 20 }, // right
  { x1: 20, y1: 7, x2: 20, y2: 13 },  // top
  { x1: 20, y1: 27, x2: 20, y2: 33 }, // bottom
];
