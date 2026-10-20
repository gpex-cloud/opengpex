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
 * Pure callout geometry shared by creation (definition), the SVG preview and the
 * GPU translator. No React here: this module sits on the render side.
 */

/**
 * Half width of the tail triangle's base, which lies ACROSS THE BODY CENTRE.
 *
 * The visible wedge is only the part outside the body, and a triangle narrows
 * toward its tip — so a base sized for the centre would be far thinner where the
 * tail actually leaves the body. The size is therefore specified at the BODY
 * EDGE (the opening the user sees: at least 2.5 strokes wide so the stroke ring
 * leaves a visible interior, else 24% of the body's short side) and scaled back
 * to the centre by the ray geometry: width(centre) = width(edge) × L / (L − t),
 * with L the centre→tip distance and t the centre→edge distance along that ray.
 * Capped at half the short side; with the tip inside the body the triangle is
 * hidden anyway and the edge value is returned as-is. ONE formula shared by
 * the GPU translator and the SVG drag preview.
 */
export function calloutTailHalfBase(
  body: { x: number; y: number; w: number; h: number },
  tip: { x: number; y: number },
  strokeWidth: number,
): number {
  const halfAtEdge = Math.max(strokeWidth * 1.25, Math.min(body.w, body.h) * 0.12);
  const cap = Math.min(body.w, body.h) / 2;
  const dx = tip.x - (body.x + body.w / 2);
  const dy = tip.y - (body.y + body.h / 2);
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return Math.min(halfAtEdge, cap);
  // Distance along the centre→tip ray to the body rectangle's boundary.
  const tx = dx !== 0 ? (body.w / 2) * (len / Math.abs(dx)) : Infinity;
  const ty = dy !== 0 ? (body.h / 2) * (len / Math.abs(dy)) : Infinity;
  const tEdge = Math.min(tx, ty);
  if (!(len > tEdge)) return Math.min(halfAtEdge, cap);
  return Math.min(cap, (halfAtEdge * len) / (len - tEdge));
}

export interface CalloutLayout {
  /** Layer bounding (AABB of body ∪ tip, padded by the stroke). */
  bounding: { w: number; h: number };
  /** Top-left of that bounding in the INPUT frame. */
  origin: { x: number; y: number };
  /** Centre of that bounding in the INPUT frame. */
  center: { x: number; y: number };
  /** Body and tip re-expressed relative to the bounding top-left (layer-local). */
  body: { x: number; y: number; w: number; h: number };
  tip: { x: number; y: number };
}

/**
 * Lay a callout out from a body rect and a tail tip given in ANY common frame
 * (canvas-local at creation, the previous layer frame while dragging the tip):
 * the bounding is the AABB of body ∪ tip padded by the stroke half-width (+1 px
 * for AA), and body/tip come back relative to that bounding so they can be
 * stored as layer-local markerData. ONE formula for creation and tail editing.
 */
export function layoutCallout(
  body: { x: number; y: number; w: number; h: number },
  tip: { x: number; y: number },
  strokeWidth: number,
): CalloutLayout {
  const pad = Math.max(0, strokeWidth) / 2 + 1;
  const minX = Math.min(body.x, tip.x) - pad;
  const minY = Math.min(body.y, tip.y) - pad;
  const maxX = Math.max(body.x + body.w, tip.x) + pad;
  const maxY = Math.max(body.y + body.h, tip.y) + pad;
  const w = maxX - minX;
  const h = maxY - minY;
  return {
    bounding: { w, h },
    origin: { x: minX, y: minY },
    center: { x: minX + w / 2, y: minY + h / 2 },
    body: { x: body.x - minX, y: body.y - minY, w: body.w, h: body.h },
    tip: { x: tip.x - minX, y: tip.y - minY },
  };
}
