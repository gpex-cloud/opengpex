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
 * Pure geometry helpers for whole-layer transforms of committed pen layers.
 *
 * The layer model has no scale channel (`Layer.scale` is deprecated at 1.0),
 * so a whole-layer resize must BAKE into `penData`: every anchor coordinate
 * is scaled by the resize factors, the layer's `bounding` is updated to the
 * scaled extents, and the world centre is re-derived by the caller. Anchors
 * stay layer-local with the origin at the bounding top-left (the commit
 * convention), so the bake is a straight multiply with no origin juggling.
 *
 * Bézier handles are stored RELATIVE to their anchor (`PenAnchor.handleIn/
 * handleOut` are offset vectors). Under a scale, an offset vector must be
 * scaled by the same factors — this is the same affine mapping semantics as
 * the overlay renderer's point map (absolute endpoint mapped, then re-based
 * against the mapped anchor).
 */

import type { CubicSegment, PenLayerStyle, PenPathData, Point2D } from '@opengpex/editor/core/types';

/**
 * The two L0 flattening ops the rebase needs, injected by the caller. Plugins
 * must not import the internal geometry operators directly (ESLint
 * no-restricted-imports) — handlers pass `geometry.bezier` from the
 * InteractionEvent; tests may pass the operators directly.
 */
export interface PenFlattenOps {
  penPathToCubicSegments(path: PenPathData): CubicSegment[];
  flattenCubicChain(segments: readonly CubicSegment[], toleranceDocPx: number): Point2D[];
}



// ─── Anchor-edit bounds rebase ─────────────────────────────────────────────────

/**
 * The bounding pad a pen layer carries around its flattened path extents:
 * half the stroke width (the boundary band extrudes that far beyond the
 * centerline) plus 1px of AA headroom — fill-only layers keep a minimal rim
 * for the same reason. The commit command inflates by exactly this pad and
 * shifts the anchors so the layer-local origin stays the INFLATED bounds'
 * top-left; anchor edits must re-apply the same convention or the scene
 * assembler's crop (visibleShape) clips the moved geometry.
 */
export function penBoundsPad(style: PenLayerStyle | undefined | null): number {
  return Math.ceil((style?.stroke ? style.stroke.width / 2 : 0.375) + 1);
}

export interface PenDataRebase {
  /** The payload re-anchored so its flattened extents start at (pad, pad). */
  penData: PenPathData;
  /** Layer-local shift from the OLD origin to the NEW origin. */
  shift: { x: number; y: number };
  /** New bounding: flattened extents inflated by `pad` per side. */
  bounding: { w: number; h: number };
}

/**
 * Re-anchors an edited pen payload to the commit convention: the flattened
 * curve's extents are measured exactly (adaptive flattening, the same L0 ops
 * the commit path uses), every anchor is shifted so the extents start at
 * (pad, pad) inside the layer-local frame, and the bounding is the inflated
 * extents. `pad` comes from {@link penBoundsPad}; `ops` from
 * `geometry.bezier`. Returns null for a payload with no flattenable geometry
 * (nothing to bound). Pure.
 */
export function rebasePenDataToBounds(penData: PenPathData, pad: number, ops: PenFlattenOps): PenDataRebase | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const seg of ops.penPathToCubicSegments(penData)) {
    for (const pt of ops.flattenCubicChain([seg], 0.25)) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  const shift = { x: minX - pad, y: minY - pad };
  return {
    penData: {
      paths: penData.paths.map((sub) => ({
        closed: sub.closed,
        anchors: sub.anchors.map((a) => ({ ...a, x: a.x - shift.x, y: a.y - shift.y })),
      })),
    },
    shift,
    bounding: {
      w: Math.max(1, maxX - minX + pad * 2),
      h: Math.max(1, maxY - minY + pad * 2),
    },
  };
}
