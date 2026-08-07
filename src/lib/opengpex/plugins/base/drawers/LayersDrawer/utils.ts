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

import { Layer, Frame, EditorContextValue, asLocalPolygon, asLocalRect, asLocalPoint, LocalPolygon, NormalizedState, ShapeType } from '@opengpex/editor/core/types';

/**
 * Resolved refocus target: either a regular shape (rect/ellipse) or an irregular polygon.
 * All clip boxes are now stored as LocalPolygon — regular shapes are converted via asLocalPolygon.
 */
export type RefocusTarget =
    | { regular: true; clipToolId: 'rect' | 'ellipse'; shapeType: ShapeType; canvasX: number; canvasY: number; w: number; h: number }
    | { regular: false; clipToolId: string; polygon: LocalPolygon };

/**
 * Commits a resolved RefocusTarget to the frame state:
 *   1. Switches latestClipTool
 *   2. Clears conflicting slots (for regular shapes)
 *   3. Writes the clip box data (always as LocalPolygon)
 *   4. Enters clip mode
 *
 * This is the unified "write to overlay" exit point for all refocus paths
 * (rect, ellipse, lasso, wand, sam).
 */
export function commitRefocusToOverlay(
    ctx: EditorContextValue,
    frame: Frame,
    target: RefocusTarget
) {
    // 1. Switch active clip tool
    ctx.actions.updateFrame(frame.id, { latestClipTool: target.clipToolId });

    if (target.regular) {
        // 2a. Clear the opposite regular slot to prevent stale rendering
        const oppositeSlot = target.clipToolId === 'ellipse' ? 'rect' : 'ellipse';
        if (frame.clipBoxes[oppositeSlot]) {
            ctx.actions.setClipBox(frame.id, oppositeSlot, null);
        }

        // 3a. Write regular shape as LocalPolygon (rect = 4 corners, ellipse = 4 corners)
        const rect = asLocalRect({ x: target.canvasX, y: target.canvasY, w: target.w, h: target.h });
        const { x, y, w, h } = rect;
        const ring = [
            asLocalPoint({ x, y }),
            asLocalPoint({ x: x + w, y }),
            asLocalPoint({ x: x + w, y: y + h }),
            asLocalPoint({ x, y: y + h }),
        ];
        ctx.actions.setClipBox(frame.id, target.clipToolId, asLocalPolygon([ring], rect, true));
    } else {
        // 3b. Write irregular polygon
        ctx.actions.setClipBox(frame.id, target.clipToolId, target.polygon);
    }

    // 4. Enter clip mode
    ctx.actions.setInteraction({ interactionMode: 'clip' });
}

// ─── Adjustment indicator ─────────────────────────────────────────────────────

/**
 * Returns `true` when a layer carries any non-identity adjustment state
 * (basic sliders, curves, levels, channel mix, or color balance).
 *
 * Used by `LayerItem` to render the purple "has adjustments" indicator dot.
 * Self-contained — intentionally does NOT import from `engine/protocol/normalizer`
 * to keep LayersDrawer free of render-engine coupling.
 */
export function hasLayerAdjustments(layer: Layer): boolean {
  // Basic adjustments (brightness/contrast/saturation/hueRotate/blur)
  const adj = layer.adjustments;
  if (adj) {
    if (adj.brightness !== 100 || adj.contrast !== 100 || adj.saturation !== 100 ||
        adj.hueRotate !== 0 || adj.blur !== 0) return true;
  }

  // Curves — identity is [[0,0],[1,1]] per channel (or undefined)
  const c = layer.curves;
  if (c) {
    const isId = (pts?: Array<[number, number]>) =>
      !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1);
    if (!isId(c.rgb) || !isId(c.red) || !isId(c.green) || !isId(c.blue)) return true;
  }

  // Levels — identity: 0/255/1.0/0/255
  const l = layer.levels;
  if (l) {
    if (l.inputBlack !== 0 || l.inputWhite !== 255 || l.gamma !== 1 ||
        l.outputBlack !== 0 || l.outputWhite !== 255) return true;
  }

  // Channel Mix — identity: red=[1,0,0], green=[0,1,0], blue=[0,0,1], constant=[0,0,0]
  const m = layer.channelMix;
  if (m) {
    const eq3 = (v: [number, number, number], a: number, b: number, cc: number) =>
      v[0] === a && v[1] === b && v[2] === cc;
    if (!eq3(m.red, 1, 0, 0) || !eq3(m.green, 0, 1, 0) || !eq3(m.blue, 0, 0, 1)) return true;
    if (m.constant && !eq3(m.constant, 0, 0, 0)) return true;
  }

  // Color Balance — identity: all zeros
  const cb = layer.colorBalance;
  if (cb) {
    const z3 = (v: [number, number, number]) => v[0] === 0 && v[1] === 0 && v[2] === 0;
    if (!z3(cb.shadows) || !z3(cb.midtones) || !z3(cb.highlights)) return true;
  }

  return false;
}

/**
 * Re-constructs the full flat layer list based on a reordered host list.
 * Maintains child layer positions relative to their parents.
 */
export function calcFullLayerStack(
    hostLayers: Layer[],
    allLayers: NormalizedState<Layer>
): Layer[] {
    const fullLayers: Layer[] = [];

    hostLayers.forEach(host => {
        fullLayers.push(host);
        // Find all children belonging to this host (parentId match)
        const children = allLayers.order.map(id => allLayers.byId[id]).filter(l => l.hostId === host.id);
        fullLayers.push(...children);
    });

    return fullLayers;
}
