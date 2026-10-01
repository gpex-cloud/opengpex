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
 * geometry.ts — Pure geometry for the logic brush's commit-time box tightening.
 *
 * WHY IT EXISTS: while the pointer is down the stroke layer wears a
 * CANVAS-SIZED box (`cx = cy = 0`, trajectory in plain canvas coordinates) so
 * every new sample can just be appended — no box recomputation, no re-basing,
 * no visual jump mid-drag. On pointerup the layer is tightened to a snug box,
 * matching the legacy raster brush's persisted geometry (its bake step crops to
 * the dirty rect + 1px, clamped to the canvas), so a stroke layer behaves like
 * any other layer in the layers panel, in transforms and in export.
 *
 * INVARIANCE (the load-bearing property, unit-tested): re-basing the trajectory
 * into the tightened box must not move a single pixel on screen. A local point
 * `p` sits at world `cx - w/2 + p.x`; before tightening that is `p.x - W/2`,
 * and after it is `(x0 + w/2 - W/2) - w/2 + (p.x - x0)` = `p.x - W/2`. Identical
 * for any box, including a clamped one.
 *
 * Kept free of React / editor services on purpose: it is the one part of the
 * overlay worth a golden test.
 *
 * @module plugins/base/overlays/BrushOverlay/geometry
 */

import type { StrokePoint } from '@opengpex/editor/core/types';
import { STROKE_BOX_PADDING_EXTRA_PX } from './protocols';

/** An axis-aligned box in canvas coordinates. */
export interface StrokeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The tightened stroke: box-local trajectory + the layer geometry to write. */
export interface TightenedStroke {
  /** Trajectory re-based into the tightened box (layer-local logical pixels). */
  points: StrokePoint[];
  /** The tightened box in canvas coordinates (its w/h become `layer.bounding`). */
  box: StrokeBox;
  /** World-space centre of the box (`layer.cx`). */
  cx: number;
  /** World-space centre of the box (`layer.cy`). */
  cy: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Tighten a canvas-space trajectory into a snug, canvas-clamped layer box.
 *
 * @param points  Trajectory in CANVAS coordinates (the in-drag representation).
 * @param size    Tip diameter at pressure 1 (`StrokeData.size`, logical px).
 * @param canvas  Canvas extent; the box is clamped into it, exactly as the
 *                legacy brush's bake-time crop is.
 * @returns The re-based trajectory + layer geometry, or `null` for an empty
 *          trajectory (nothing to place).
 *
 * The raw bounding box is inflated by `size / 2 + 1`: half the tip diameter is
 * how far the ribbon reaches from its centre-line, and the extra pixel covers
 * the fragment shader's analytic edge feather. Padding uses the full `size`
 * rather than the per-sample `size × pressure` so that a later pressure edit
 * cannot spill outside the box.
 */
export function tightenStroke(
  points: readonly StrokePoint[],
  size: number,
  canvas: { w: number; h: number },
): TightenedStroke | null {
  if (points.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const pad = Math.max(0, size) / 2 + STROKE_BOX_PADDING_EXTRA_PX;
  const cw = Math.max(1, canvas.w);
  const ch = Math.max(1, canvas.h);

  // Pixel-align outwards, then clamp into the canvas. A stroke drawn entirely
  // outside the canvas collapses to a degenerate 1px box on that edge — it
  // renders nothing, which is what a fully off-canvas stroke should do.
  const x0 = clamp(Math.floor(minX - pad), 0, cw);
  const y0 = clamp(Math.floor(minY - pad), 0, ch);
  const x1 = clamp(Math.ceil(maxX + pad), 0, cw);
  const y1 = clamp(Math.ceil(maxY + pad), 0, ch);

  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);

  return {
    points: points.map((p) => ({ x: p.x - x0, y: p.y - y0, pressure: p.pressure })),
    box: { x: x0, y: y0, w, h },
    // World origin is the canvas centre (see GeometryService.localToWorld).
    cx: x0 + w / 2 - cw / 2,
    cy: y0 + h / 2 - ch / 2,
  };
}
