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
import { calloutTailHalfBase } from './geometry';

/** Mask ids for the callout preview (one preview is live at a time). */
const MASK_OUTSIDE_TAIL = 'gpex-marker-callout-outside-tail';
const MASK_OUTSIDE_BODY_INTERIOR = 'gpex-marker-callout-outside-body-interior';

/**
 * Body rounded rect ∪ tail wedge, previewed as ONE outline like the GPU union.
 * The tail triangle's base lies across the body centre (same model as the SDF),
 * so two masks remove the seams a naive overdraw would show:
 *  - the tail's stroke is masked to OUTSIDE the body's interior (inside the
 *    stroke band): it runs on through the band and stops at the band's INNER
 *    edge, so the slanted cut it makes in that band is covered, not left bare;
 *  - the body's stroke is masked to OUTSIDE the tail triangle (the body edge
 *    segment under the wedge disappears, opening the body into the tail);
 *  - the tail's fill uses the same mask, so the two fills tile the union exactly
 *    and a translucent fill never doubles up.
 */
export function calloutToSvg(data: CalloutMarkerData, bounding: MarkerBounding): string {
  const sw = Math.max(0, data.stroke.width);
  const half = sw / 2;
  const { body, tip } = data;
  const w = Math.max(0, body.w - sw);
  const h = Math.max(0, body.h - sw);
  if (w <= 0 || h <= 0) return '';

  const radius = clampRadius(data.cornerRadius, w, h);
  const stroke = svgStroke(data);
  const hasFill = data.fill.opacity > 0;
  const fillAttrs = svgFillAttrs(data);

  const cx = body.x + body.w / 2;
  const cy = body.y + body.h / 2;
  const dx = tip.x - cx;
  const dy = tip.y - cy;
  const len = Math.hypot(dx, dy) || 1e-4;
  const halfBase = calloutTailHalfBase(body, tip, sw);
  const perpX = (-dy / len) * halfBase;
  const perpY = (dx / len) * halfBase;
  const tailPoints = `${tip.x},${tip.y} ${cx + perpX},${cy + perpY} ${cx - perpX},${cy - perpY}`;

  // Mask canvas: the whole layer plus a stroke margin so nothing is clipped.
  const pad = sw + 2;
  const canvas = `<rect x="${-pad}" y="${-pad}" width="${bounding.w + 2 * pad}" height="${bounding.h + 2 * pad}" fill="#fff" />`;
  // The body's interior INSIDE its stroke band. The SVG stroke is centred on the
  // inset-by-half rect, so the band's inner edge is a full stroke in from the
  // body edge — not half (that is the stroke's centre line; masking there cuts
  // the tail stroke mid-band and leaves a step). The corner radius shrinks with
  // the inset.
  const innerW = Math.max(0, body.w - 2 * sw);
  const innerH = Math.max(0, body.h - 2 * sw);
  const innerR = Math.max(0, radius - half);
  const bodyInner = `<rect x="${body.x + sw}" y="${body.y + sw}" width="${innerW}" height="${innerH}" rx="${innerR}" ry="${innerR}" fill="#000" />`;
  const tailSolid = `<polygon points="${tailPoints}" fill="#000" />`;

  const fills = hasFill
    ? `<polygon points="${tailPoints}" ${fillAttrs} mask="url(#${MASK_OUTSIDE_BODY_INTERIOR})" />` +
      `<rect x="${body.x + half}" y="${body.y + half}" width="${w}" height="${h}" rx="${radius}" ry="${radius}" ${fillAttrs} />`
    : '';

  return (
    `<defs>` +
    `<mask id="${MASK_OUTSIDE_TAIL}">${canvas}${tailSolid}</mask>` +
    `<mask id="${MASK_OUTSIDE_BODY_INTERIOR}">${canvas}${bodyInner}</mask>` +
    `</defs>` +
    fills +
    `<polygon points="${tailPoints}" fill="none" ` +
    `stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" mask="url(#${MASK_OUTSIDE_BODY_INTERIOR})" />` +
    `<rect x="${body.x + half}" y="${body.y + half}" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="none" ` +
    `stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="miter" mask="url(#${MASK_OUTSIDE_TAIL})" />`
  );
}

/** `callout`: [body.x, body.y, body.w, body.h, tip.x, tip.y, cornerRadius, tailHalfBase]. */
export function calloutToSdf(data: CalloutMarkerData, _size: MarkerBounding): SdfGeometry {
  const { body, tip } = data;
  const maxR = Math.min(body.w, body.h) / 2;
  const r = Math.min(Math.max(0, data.cornerRadius ?? 0), maxR);
  return {
    prim: 'callout',
    shapeParams: [body.x, body.y, body.w, body.h, tip.x, tip.y, r, calloutTailHalfBase(body, tip, data.stroke.width)],
  };
}
