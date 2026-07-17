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

import { Layer, Frame, EditorContextValue, asLocalShape, LocalPolygon, NormalizedState, ShapeType } from '@opengpex/editor/core/types';

/**
 * Resolved refocus target: either a regular shape (rect/ellipse) or an irregular polygon.
 */
export type RefocusTarget =
    | { regular: true; clipToolId: 'rect' | 'ellipse'; shapeType: ShapeType; canvasX: number; canvasY: number; w: number; h: number }
    | { regular: false; clipToolId: string; polygon: LocalPolygon };

/**
 * Commits a resolved RefocusTarget to the frame state:
 *   1. Switches latestClipTool
 *   2. Clears conflicting slots (for regular shapes)
 *   3. Writes the clip box data
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

        // 3a. Write regular shape
        ctx.actions.setClipBox(frame.id, target.clipToolId, asLocalShape({
            x: target.canvasX,
            y: target.canvasY,
            w: target.w,
            h: target.h
        }, target.shapeType));
    } else {
        // 3b. Write irregular polygon
        ctx.actions.setClipBox(frame.id, target.clipToolId, target.polygon);
    }

    // 4. Enter clip mode
    ctx.actions.setInteraction({ interactionMode: 'clip' });
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
