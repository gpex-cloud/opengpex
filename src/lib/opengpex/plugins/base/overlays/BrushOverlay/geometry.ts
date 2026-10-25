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
 * @param clipRect  Optional additional clamp: the active selection's bounding
 *                box (canvas coordinates) inflated by 1px of AA margin. The
 *                box is clamped into the INTERSECTION of canvas and clipRect —
 *                coverage outside the selection is zero by the confinement
 *                multiply, so texels out there would be allocated for nothing.
 *                A stroke fully outside the selection collapses to a degenerate
 *                1px box on the selection edge and renders nothing (same
 *                posture as a fully off-canvas stroke).
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
  clipRect?: { x: number; y: number; w: number; h: number },
): TightenedStroke | null {
  if (points.length === 0) return null;

  // Box extent: when a selection clip rect is given, measure it from the
  // parts of the trajectory that actually CROSS the rect — the raw trajectory
  // bbox would drag in the clipped-away tails (a diagonal stroke crossing the
  // selection corner-to-corner would keep the whole off-selection span as
  // permanently transparent box area). Per-SEGMENT Liang-Barsky clip against
  // the rect: segment-level, not point-level, because a sparse straight
  // crossing can have BOTH endpoint samples outside the selection while the
  // segment between them paints right through it. A lone point (no segments)
  // counts only when it is itself inside. The POINT STREAM is never trimmed —
  // this only decides the box; the coverage multiply clips the pixels.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  if (clipRect) {
    const rX0 = clipRect.x, rY0 = clipRect.y;
    const rX1 = clipRect.x + clipRect.w, rY1 = clipRect.y + clipRect.h;
    const grow = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    // Liang-Barsky: parametric clip of segment (a→b) against the rect.
    // Returns the visible sub-segment's endpoints, or null when it misses.
    const clipSegment = (ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax, dy = by - ay;
      let t0 = 0, t1 = 1;
      const p = [-dx, dx, -dy, dy];
      const q = [ax - rX0, rX1 - ax, ay - rY0, rY1 - ay];
      for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
          if (q[i] < 0) return null;
        } else {
          const r = q[i] / p[i];
          if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
          else { if (r < t0) return null; if (r < t1) t1 = r; }
        }
      }
      return { x0: ax + t0 * dx, y0: ay + t0 * dy, x1: ax + t1 * dx, y1: ay + t1 * dy };
    };
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      if (i + 1 < points.length) {
        const b = points[i + 1];
        const seg = clipSegment(a.x, a.y, b.x, b.y);
        if (seg) { grow(seg.x0, seg.y0); grow(seg.x1, seg.y1); }
      } else if (points.length === 1 && a.x >= rX0 && a.x <= rX1 && a.y >= rY0 && a.y <= rY1) {
        grow(a.x, a.y);
      }
    }
  } else {
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  if (clipRect && (minX === Infinity || maxX < minX || maxY < minY)) {
    // Nothing crosses the selection — collapse to a degenerate 1px box on the
    // nearest selection edge (same posture as off-canvas strokes).
    const cw0 = Math.max(1, canvas.w);
    const ch0 = Math.max(1, canvas.h);
    const loX = Math.max(0, clipRect.x);
    const loY = Math.max(0, clipRect.y);
    const hiX = Math.min(cw0, clipRect.x + clipRect.w);
    const hiY = Math.min(ch0, clipRect.y + clipRect.h);
    const cx = clamp(Math.floor(points[0].x), loX, hiX);
    const cy = clamp(Math.floor(points[0].y), loY, hiY);
    return {
      points: points.map((p) => ({ x: p.x - cx, y: p.y - cy, pressure: p.pressure })),
      box: { x: cx, y: cy, w: 1, h: 1 },
      cx: cx + 0.5 - cw0 / 2,
      cy: cy + 0.5 - ch0 / 2,
    };
  }

  const pad = Math.max(0, size) / 2 + STROKE_BOX_PADDING_EXTRA_PX;
  const cw = Math.max(1, canvas.w);
  const ch = Math.max(1, canvas.h);

  // Pixel-align outwards, then clamp into the canvas ∩ (optional) selection
  // bounding box. A stroke drawn entirely outside either bound collapses to a
  // degenerate 1px box on that edge — it renders nothing, which is what a
  // fully off-canvas (or fully out-of-selection) stroke should do. The clip
  // rect arrives pre-inflated by its AA margin from the caller.
  const loX = clipRect ? Math.max(0, clipRect.x) : 0;
  const loY = clipRect ? Math.max(0, clipRect.y) : 0;
  const hiX = clipRect ? Math.min(cw, clipRect.x + clipRect.w) : cw;
  const hiY = clipRect ? Math.min(ch, clipRect.y + clipRect.h) : ch;
  const x0 = clamp(Math.floor(minX - pad), loX, hiX);
  const y0 = clamp(Math.floor(minY - pad), loY, hiY);
  const x1 = clamp(Math.ceil(maxX + pad), loX, hiX);
  const y1 = clamp(Math.ceil(maxY + pad), loY, hiY);

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
