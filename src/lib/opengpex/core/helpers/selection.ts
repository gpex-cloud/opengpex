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

import type { Frame, LocalPolygon, LocalShape, Dimensions } from '@opengpex/editor/core/types';
import { asLocalShape } from '@opengpex/editor/core/types';

/**
 * getRegularClipShape — convenience wrapper over `getClipBox` that returns
 * the active selection ONLY when it is a regular (rect/ellipse) LocalPolygon
 * (i.e. a 4-point or 64-point polygon produced by the rect/ellipse tool).
 *
 * Delegates entirely to `getClipBox(frame)` which reads `frame.latestClipTool`
 * as the single source of truth. No more blind-scanning of slot arrays.
 *
 * Returns `undefined` when no valid clip polygon is active (slot is empty).
 */
export function getRegularClipShape(frame: { latestClipTool?: string; clipBoxes: Record<string, LocalPolygon> }): LocalPolygon | undefined {
  return getClipBox(frame as Frame) ?? undefined;
}

/**
 * getClipBox — unified selection resolver for clip commands.
 *
 * Reads `frame.latestClipTool` to determine which slot in `frame.clipBoxes`
 * holds the active selection and returns the `LocalPolygon` directly.
 *
 * All tool types (rect, ellipse, lasso, wand) now store a `LocalPolygon`.
 * Consumers that need a `LocalShape` for the rendering pipeline should call
 * `polygonToShape(box)` from `@opengpex/editor/core/geometry/operators/polygon`.
 *
 * Returns `null` when no valid selection exists (missing slot).
 *
 * @example
 * ```ts
 * const box = getClipBox(frame);
 * if (!box) return; // no active selection
 * // box is LocalPolygon — use rings for mask, or polygonToShape for rendering
 * applyPolygonMask(box.rings);
 * ```
 */
export function getClipBox(frame: Frame): LocalPolygon | null {
  const clipToolId = frame.latestClipTool || 'rect';

  // Guard: legacy imported data may not have clipBoxes at all.
  const entry = frame.clipBoxes?.[clipToolId] ?? null;
  if (!entry) return null;

  // LocalPolygon — trust that it has valid points
  return entry;
}

// ─── Re-Canvas Default ClipBox ──────────────────────────────────────────────────

/**
 * Re-Canvas default scale factor relative to canvas dimensions.
 * 1.1 = 110% of canvas (extends 10% beyond one or more edges).
 */
const RE_CANVAS_DEFAULT_SCALE = 1.1;

/**
 * Alignment anchor for the default Re-Canvas clip box.
 *
 * Determines where the original canvas sits within the enlarged clip box:
 *   - `tl` — top-left: expansion goes right and down
 *   - `tr` — top-right: expansion goes left and down
 *   - `bl` — bottom-left: expansion goes right and up (DEFAULT)
 *   - `br` — bottom-right: expansion goes left and up
 *   - `ct` — center: expansion is equal on all sides
 */
export type ClipBoxAnchor = 'tl' | 'tr' | 'bl' | 'br' | 'ct';

/**
 * getDefaultCanvasClipBox — computes the default Re-Canvas clip box for a
 * given canvas dimension.
 *
 * The clip box is sized to `RE_CANVAS_DEFAULT_SCALE` (currently 1.1×) of the
 * canvas dimensions, giving the user immediate room to expand the canvas
 * outward without first resizing the selection.
 *
 * @param dim - Canvas dimensions `{ w, h }`
 * @param anchor - Alignment anchor (default: `'bl'` — bottom-left)
 * @returns A `LocalShape` representing the default Re-Canvas clip box.
 */
export function getDefaultCanvasClipBox(dim: Dimensions, anchor: ClipBoxAnchor = 'bl'): LocalShape {
  const scale = RE_CANVAS_DEFAULT_SCALE;
  // Pixel editor invariant: clip box must have integer dimensions and position.
  // scale (1.1) applied to arbitrary canvas sizes can produce non-integers.
  const newW = Math.round(dim.w * scale);
  const newH = Math.round(dim.h * scale);

  let x: number;
  let y: number;

  switch (anchor) {
    case 'tl': // original canvas top-left = clip box top-left
      x = 0;
      y = 0;
      break;
    case 'tr': // original canvas top-right = clip box top-right
      x = dim.w - newW;
      y = 0;
      break;
    case 'bl': // original canvas bottom-left = clip box bottom-left
      x = 0;
      y = dim.h - newH;
      break;
    case 'br': // original canvas bottom-right = clip box bottom-right
      x = dim.w - newW;
      y = dim.h - newH;
      break;
    case 'ct': // centered
    default:
      x = Math.round((dim.w - newW) / 2);
      y = Math.round((dim.h - newH) / 2);
      break;
  }

  return asLocalShape({ x, y, w: newW, h: newH });
}
