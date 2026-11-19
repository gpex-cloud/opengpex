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

/** Callout render: SVG preview + SDF geometry. Pure — no React. */

import type { CalloutMarkerData } from '../../types';
import type { MarkerBounding, SdfGeometry } from '../../types';
import { clampRadius, svgFillAttrs, svgStroke } from '../shared';
import { solverRingSvg, fillOverlay } from '../polygon-family/geometry';
import { sdfSolverOutline } from '@opengpex/editor/core/engine/pipeline/scene/sdfPolygonSolver';
import { calloutTailHalfBase } from './geometry';

/** `callout`: [body.x, body.y, body.w, body.h, tip.x, tip.y, cornerRadius, tailHalfBase]. */
function calloutShapeParams(data: CalloutMarkerData): readonly number[] {
  const { body, tip } = data;
  const maxR = Math.min(body.w, body.h) / 2;
  const r = Math.min(Math.max(0, data.cornerRadius ?? 0), maxR);
  return [body.x, body.y, body.w, body.h, tip.x, tip.y, r, calloutTailHalfBase(body, tip, data.stroke.width)];
}

/**
 * The preview IS the engine's solver artifact: the analytic outline (body ∪
 * tail wedge, rounded corners polygonized) draws as ONE evenodd ring with the
 * fill UNDER it — the same rings the GPU area-integrates, so translucent ink
 * never double-blends and no fill/stroke seam can open. This replaces the old
 * two-mask, three-element markup whose complementary masked strokes and fills
 * lost `cov·(1−cov)` alpha along every shared AA boundary.
 *
 * Only pathological degenerate outlines (never reachable for a well-formed
 * callout) fall to a plain body markup so the preview cannot go blank.
 */
export function calloutToSvg(data: CalloutMarkerData, bounding: MarkerBounding): string {
  const sw = Math.max(0, data.stroke.width);
  const half = sw / 2;
  const { body } = data;
  // Preview from the FIRST pixel of the drag (parity with polygon-family):
  // a body at or below the stroke width is SOLID (the erosion probe empties
  // the interior and the solver ring paints the whole shape) — exactly what
  // the GPU renders. The old `body − stroke > 0` blanking was a leftover of
  // the mask-era markup that needed an inner strokeable rect.
  if (body.w <= 0 || body.h <= 0) return '';

  const outline = sdfSolverOutline(
    'callout', [bounding.w, bounding.h], sw, calloutShapeParams(data), 0,
  );
  if (outline) {
    const ring = solverRingSvg(outline, svgStroke(data));
    // Fill UNDER the band (the GPU composites stroke OVER fill).
    if (ring) return fillOverlay(data, outline) + ring;
  }

  // Degenerate guard: body-only markup. The GPU legacy path still paints the
  // full union shape; this branch exists so the preview never blanks.
  const w = Math.max(0, body.w - sw);
  const h = Math.max(0, body.h - sw);
  const radius = clampRadius(data.cornerRadius, Math.max(1, w), Math.max(1, h));
  return (
    `<rect x="${body.x + half}" y="${body.y + half}" width="${w}" height="${h}" rx="${radius}" ry="${radius}" ` +
    `${svgFillAttrs(data)} stroke="${svgStroke(data)}" stroke-width="${sw}" stroke-linejoin="miter" />`
  );
}

/** `callout`: [body.x, body.y, body.w, body.h, tip.x, tip.y, cornerRadius, tailHalfBase]. */
export function calloutToSdf(data: CalloutMarkerData, _size: MarkerBounding): SdfGeometry {
  return {
    prim: 'callout',
    shapeParams: calloutShapeParams(data),
  };
}
