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

import { LocalRect, Shape, Point2D } from '@opengpex/editor/core/types';
import { parsePathDataToRings, ringsToPathData } from '@opengpex/editor/core/geometry/operators/point2d';
import { SEAM_SHRINK_HOLE, SEAM_EXPAND_FRAGMENT } from './config';

/**
 * shrinkInvertedMask: Physical anti-aliasing seam prevention mask shrinker (Subpixel Mask Seam Prevention)
 * Specially used at the physical rendering level to automatically shrink "inverted masks" (e.g. holes, peeled cutouts with inverted = true) inward.
 *
 * [Fix Principle]:
 * To eliminate the 1px semi-transparent seam (Anti-Aliasing border) caused by Canvas 2D clip under camera scaling/zoom:
 * Instead of a fixed logical shrink (e.g. 0.5px), we dynamically calculate the logical shrink based on the current rendering scale:
 * `shrinkLogical = 0.75 / scale`.
 *
 * This ensures that when the browser applies the transformation matrix, the physical shrink in screen space is ALWAYS
 * exactly 0.75 physical pixels. This constant screen-space overlap completely absorbs the browser's anti-aliasing border
 * and any floating-point sub-pixel inaccuracies, ensuring perfect layout seamlessness at all zoom levels (e.g. 10% to 1000%).
 *
 * We clamp the logical shrink to at most 25% of the shape's smaller dimension to prevent self-inversion for tiny shapes.
 *
 * [Boundary-Aware Shrink]:
 * When `layerBounds` is provided, edges that coincide with (or are within 1px of) the layer boundary
 * are NOT shrunk. There is no AA seam at the layer boundary (no image content beyond it), so shrinking
 * those edges would only create a visible 1-pixel gap when the user drills along the image edge.
 *
 * Shared pure function supporting geometric operations under both the main thread and the WebWorker background compositing thread.
 */
export function shrinkInvertedMask<T extends Shape>(shape: T, inverted: boolean, scale = 1, layerBounds?: { w: number; h: number }): T {
  // If in hard-edge (non-anti-aliasing) mode, absolutely immune to any subpixel level position offsets!
  // Otherwise it will break the integer pixel alignment of hard edges, causing anti-aliasing to reappear.
  if (shape.antiAliased === false) {
    return shape;
  }

  if (!inverted) return shape;
  if (!SEAM_SHRINK_HOLE) return shape;

  if (shape.type === 'rect' || shape.type === 'circle') {
    // 0.75 physical pixels, mapped to logical space.
    // Clamp to at most 25% of the shape's smaller dimension to prevent self-intersection/disappearance.
    const maxShrink = 0.25 * Math.min(shape.rect.w, shape.rect.h);
    const shrinkLogical = Math.min(0.75 / scale, maxShrink);

    // Boundary-aware: skip shrink on edges touching the layer boundary (within 1px tolerance).
    // At boundary edges, there's no image content beyond → no AA seam can exist → shrink is harmful.
    const EDGE_TOLERANCE = 1;
    const touchLeft = layerBounds ? shape.rect.x < EDGE_TOLERANCE : false;
    const touchTop = layerBounds ? shape.rect.y < EDGE_TOLERANCE : false;
    const touchRight = layerBounds ? (shape.rect.x + shape.rect.w) > (layerBounds.w - EDGE_TOLERANCE) : false;
    const touchBottom = layerBounds ? (shape.rect.y + shape.rect.h) > (layerBounds.h - EDGE_TOLERANCE) : false;

    const shrinkLeft = touchLeft ? 0 : shrinkLogical;
    const shrinkTop = touchTop ? 0 : shrinkLogical;
    const shrinkRight = touchRight ? 0 : shrinkLogical;
    const shrinkBottom = touchBottom ? 0 : shrinkLogical;

    return {
      ...shape,
      rect: {
        ...shape.rect,
        x: shape.rect.x + shrinkLeft,
        y: shape.rect.y + shrinkTop,
        w: Math.max(0.1, shape.rect.w - shrinkLeft - shrinkRight),
        h: Math.max(0.1, shape.rect.h - shrinkTop - shrinkBottom)
      } as typeof shape.rect
    };
  }

  if (shape.type === 'path' && (shape as unknown as { pathData?: string }).pathData) {
    // Path-type hole mask: shrink via vertex-normal inset on each ring.
    // Same dynamic shrink logic: 0.75 physical pixels mapped to logical space.
    const maxShrink = 0.25 * Math.min(shape.rect.w, shape.rect.h);
    const shrinkLogical = Math.min(0.75 / scale, maxShrink);

    const pathData = (shape as unknown as { pathData: string }).pathData;
    const shrunkPathData = shrinkPathData(pathData, shrinkLogical, layerBounds);
    return {
      ...shape,
      pathData: shrunkPathData,
    } as unknown as T;
  }

  return shape;
}

/**
 * snapClipBoxToPixels: Selection crop box pixel-level grid alignment snapper (Pixel Gridding Snapper)
 * Employs a "coordinate pair dual-end rounding" algorithm, perfectly preventing size drift and physical stretch errors of aspect ratios caused by independent rounding.
 * Exported as a shared pure function, supporting geometric grid alignment under both the main thread and WebWorker environments.
 */
export function snapClipBoxToPixels<T extends { rect: LocalRect }>(cropBox: T): T {
  const { rect } = cropBox;
  if (!rect) return cropBox;

  // Intentionally empty rect (no active selection) — skip snapping to avoid
  // the Math.max(1,...) floor from synthesizing a 1×1 ghost box.
  if (rect.w <= 0 && rect.h <= 0) return cropBox;

  const x1 = Math.round(rect.x);
  const y1 = Math.round(rect.y);
  const x2 = Math.round(rect.x + rect.w);
  const y2 = Math.round(rect.y + rect.h);

  return {
    ...cropBox,
    rect: {
      ...rect,
      x: x1,
      y: y1,
      w: Math.max(1, x2 - x1),
      h: Math.max(1, y2 - y1),
    },
  };
}

// ─────────────────────────── Path Inset Helpers ────────────────────────────────

/**
 * shrinkPathData: Shrinks a pathData string inward by `amount` logical pixels
 * using vertex-normal inset on each ring.
 *
 * Boundary-aware: vertices within 1px of `layerBounds` edges are not shrunk
 * (no AA seam exists at the layer boundary).
 */
function shrinkPathData(pathData: string, amount: number, layerBounds?: { w: number; h: number }): string {
  const rings = parsePathDataToRings(pathData);
  if (!rings.length) return pathData;

  const shrunkRings = rings.map(ring => {
    if (ring.length < 3) return ring;
    // Determine winding direction via signed area (Shoelace formula).
    // Positive area = CW = outer ring → shrink inward (positive offset)
    // Negative area = CCW = inner ring → shrink outward (negative offset)
    const area = signedArea(ring);
    const direction = area >= 0 ? 1 : -1;
    return insetRing(ring, amount * direction, layerBounds);
  });

  return ringsToPathData(shrunkRings);
}

/**
 * insetRing: Move each vertex of a ring inward by `offset` using vertex-normal averaging.
 *
 * For positive offset: vertices move in the direction of the inward normal (CW winding).
 * For negative offset: vertices move outward (used for CCW inner rings).
 *
 * Boundary-aware: if `layerBounds` is provided, vertices within 1px of any boundary
 * edge are left unchanged (no seam exists there).
 */
export function insetRing(ring: Point2D[], offset: number, layerBounds?: { w: number; h: number }): Point2D[] {
  const n = ring.length;
  const result: Point2D[] = [];
  const EDGE_TOLERANCE = 1;

  for (let i = 0; i < n; i++) {
    const curr = ring[i];

    // Boundary check: if this vertex touches layer edge, don't shrink it
    if (layerBounds) {
      const nearBoundary =
        curr.x < EDGE_TOLERANCE ||
        curr.y < EDGE_TOLERANCE ||
        curr.x > layerBounds.w - EDGE_TOLERANCE ||
        curr.y > layerBounds.h - EDGE_TOLERANCE;
      if (nearBoundary) {
        result.push(curr);
        continue;
      }
    }

    const prev = ring[(i - 1 + n) % n];
    const next = ring[(i + 1) % n];

    // Edge vectors
    const e1x = curr.x - prev.x;
    const e1y = curr.y - prev.y;
    const e2x = next.x - curr.x;
    const e2y = next.y - curr.y;

    // Edge lengths
    const len1 = Math.hypot(e1x, e1y) || 1;
    const len2 = Math.hypot(e2x, e2y) || 1;

    // Inward normals (perpendicular, pointing left of travel direction for CW winding)
    const n1x = e1y / len1;
    const n1y = -e1x / len1;
    const n2x = e2y / len2;
    const n2y = -e2x / len2;

    // Average normal
    const avgx = n1x + n2x;
    const avgy = n1y + n2y;
    const avgLen = Math.hypot(avgx, avgy) || 1;
    const normx = avgx / avgLen;
    const normy = avgy / avgLen;

    // Miter factor: compensates for angle between edges so offset is uniform
    const dot = normx * n1x + normy * n1y;
    const miter = Math.min(Math.abs(1 / (dot || 1)), 4); // cap at 4x to prevent spikes

    result.push({
      x: curr.x + normx * offset * miter,
      y: curr.y + normy * offset * miter,
    });
  }

  return result;
}

/**
 * signedArea: Compute the signed area of a polygon ring (Shoelace formula).
 * Positive = clockwise, Negative = counter-clockwise.
 */
function signedArea(ring: Point2D[]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return area / 2;
}

// ─────────────────────────── Fragment Clip Expansion (Phase 2) ──────────────────

/**
 * isExpandableFragmentClip: Determines whether a clip descriptor is an expandable
 * fragment visibleShape clip (Phase 2 seam prevention).
 *
 * Returns true when ALL of the following hold:
 *   1. clipInverted === false
 *   2. assocMaskId exists (layer is a cut fragment)
 *   3. clipShape === layerVisibleShape (reference equality)
 *   4. clipShape.type === 'path'
 *   5. clipShape.pathData exists
 *   6. clipShape.antiAliased !== false
 *
 * ── Condition necessity analysis ──
 *
 * 🔴 MUST KEEP (removing causes visible artifacts):
 *   #3 — Without this, vectorMask clips would also be expanded, distorting
 *         user-drawn mask edges by 0.75px.
 *   #6 — In hard-edge mode, expansion introduces fractional coordinates that
 *         re-introduce the anti-aliasing it was designed to avoid.
 *
 * 🟡 RECOMMENDED (removing is safe but wasteful or reduces clarity):
 *   #2 — Non-fragment layers don't have the shared-boundary seam problem.
 *         Expanding them is harmless (overdraw is clipped by drawImage bounds)
 *         but wastes ~0.01ms/layer on pointless shrinkPathData computation.
 *   #4 — rect/circle clips don't have pathData, so #5 would catch them anyway.
 *         Kept for early exit and semantic clarity.
 *   #5 — Defensive. In practice type='path' shapes always have pathData.
 *         expandFragmentClip also has its own `if (!pathData)` guard.
 *
 * 🟢 REMOVABLE (zero runtime impact in current architecture):
 *   #1 — In prepareClipSequence, the code structure guarantees only non-inverted
 *         clips reach this check. Kept for function-level self-documentation.
 */
export function isExpandableFragmentClip(
  clipShape: Shape,
  clipInverted: boolean,
  layerVisibleShape: Shape | undefined,
  assocMaskId: string | undefined,
): boolean {
  if (clipInverted) return false;
  if (!assocMaskId) return false;
  if (clipShape !== layerVisibleShape) return false;
  if (clipShape.type !== 'path') return false;
  if (!(clipShape as unknown as { pathData?: string }).pathData) return false;
  if (clipShape.antiAliased === false) return false;
  return true;
}

/**
 * expandFragmentClip: Expands a fragment's visibleShape pathData outward by 0.75/scale.
 *
 * Used at RENDER TIME ONLY (viewport painter) to create a slight overdraw that
 * covers the anti-aliasing seam between adjacent fragments sharing a visibleShape boundary.
 *
 * Controlled by `SEAM_EXPAND_FRAGMENT` config flag.
 *
 * @param pathData  The fragment's visibleShape.pathData
 * @param scale     Current rendering scale (camera.k * dpr)
 * @returns Expanded pathData string (or original if disabled/invalid)
 */
export function expandFragmentClip(pathData: string, scale: number): string {
  if (!SEAM_EXPAND_FRAGMENT) return pathData;
  if (!pathData) return pathData;
  const amount = -(0.75 / scale);
  return shrinkPathData(pathData, amount);
}
