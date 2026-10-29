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

'use client';

/**
 * utils-hotTail.ts — The HOT TAIL rules of the adjustment drawer, pure and shared
 * by the commands (write side) and the panels (read side).
 *
 * THE MODEL. A layer's grade is an ordered chain of adjustment masks
 * (`Layer.adjustMasks`); every panel commit is one single-category entry
 * appended to the chain, and the chain order is the render order. The one
 * exception is the HOT TAIL: while the user keeps working in the same
 * category, on the same layer, against the same selection, the panel edits
 * the LAST entry in place instead of stacking a new one — so "pull the curve
 * a little more" refines the last step rather than applying it twice (an
 * absolute-value slider stacked on itself would double the effect).
 *
 * The hot tail is DERIVED FROM DATA, never stored: the last mask of the chain
 * is the hot tail of category C iff it is enabled, its category is C, and
 * its coverage matches the current selection state (both whole-layer, or
 * both the same frozen polygon). Leaving the layer and coming back keeps the
 * tail editable (Photoshop: returning to an adjustment layer still edits it);
 * committing another category, changing or clearing the selection, or
 * disabling the tail freezes it — the next commit appends.
 *
 * @module plugins/base/drawers/AdjustmentDrawer/hotTail
 */

import type {
  AdjustmentMask,
  Frame,
  GeometryService,
  GradeCategory,
  Layer,
  LocalPolygon,
} from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import type { GradingTool } from './protocols';

/** Grading tool (panel id) → grade category (chain discriminator). */
export function toolCategory(tool: GradingTool): GradeCategory {
  return tool === 'mixer' ? 'channelMix' : tool;
}

/** Grade category → grading tool (panel id). */
export function categoryTool(category: GradeCategory): GradingTool {
  return category === 'channelMix' ? 'mixer' : category;
}

/**
 * Project the frame's active selection into `layer`'s local space, or
 * `undefined` when there is no selection or it is degenerate (zero area —
 * a single click or collinear points would otherwise freeze an empty mask
 * that silently confines the grade to nothing).
 */
export function projectSelectionToLayer(
  geometry: GeometryService,
  frame: Frame,
  layer: Layer,
): LocalPolygon | undefined {
  const selection = getClipBox(frame);
  if (!selection) return undefined;
  const layerPoly = geometry.polygon.frameLocalToLayerLocal(selection, frame, layer);
  const ringArea = (ring: readonly { x: number; y: number }[]) => {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  };
  const totalArea = layerPoly.rings.reduce((sum, ring) => sum + ringArea(ring), 0);
  if (!(totalArea > 0.5)) return undefined;
  return layerPoly;
}

const SHAPE_EPS = 1e-3;

/**
 * Whether a mask's frozen shape matches a (projected) selection: both absent,
 * or ring-for-ring, point-for-point equal within `SHAPE_EPS` px.
 */
export function selectionMatchesShape(
  selection: LocalPolygon | undefined,
  shape: LocalPolygon | undefined,
): boolean {
  if (!selection && !shape) return true;
  if (!selection || !shape) return false;
  if (selection.rings.length !== shape.rings.length) return false;
  for (let r = 0; r < selection.rings.length; r++) {
    const a = selection.rings[r];
    const b = shape.rings[r];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].x - b[i].x) > SHAPE_EPS || Math.abs(a[i].y - b[i].y) > SHAPE_EPS) return false;
    }
  }
  return true;
}

/**
 * The EDITABLE hot tail for `category` on `layer`: the chain's last mask when
 * it is enabled, of that category, and its coverage matches the current
 * selection. `undefined` ⇒ cold start (the panel shows defaults and the next
 * write appends a new mask).
 */
export function resolveEditableTail(
  geometry: GeometryService,
  frame: Frame,
  layer: Layer,
  category: GradeCategory,
): AdjustmentMask | undefined {
  const masks = layer.adjustMasks;
  if (!masks || masks.length === 0) return undefined;
  const tail = masks[masks.length - 1];
  // The tail must be enabled and of the panel's category, and its coverage
  // must match the current selection. A disabled tail never counts (a hidden
  // entry must not be edited silently); a coverage mismatch means the user
  // re-confined — cold start, the next write appends a new mask.
  if (!tail.enabled || tail.category !== category) return undefined;
  const selection = projectSelectionToLayer(geometry, frame, layer);
  return selectionMatchesShape(selection, tail.shape) ? tail : undefined;
}
