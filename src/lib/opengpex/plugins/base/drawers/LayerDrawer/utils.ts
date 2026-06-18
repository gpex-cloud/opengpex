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

import { Layer, Frame, EditorContextValue, asLocalShape, NormalizedState } from '@opengpex/editor/core/types';

/**
 * Executes a spatial projection to sync a world coordinate (center) 
 * and dimension to the canvas overlay crop box.
 */
export function syncToCanvasOverlay(
 ctx: EditorContextValue,
 frame: Frame,
 worldCenter: { x: number, y: number },
 scaledW: number,
 scaledH: number
) {
 // 1. Calculate top-left coordinates in Canvas Space
 // World Space Origin (0,0) is center of Canvas.
 const canvasX = worldCenter.x + frame.canvas.w / 2 - scaledW / 2;
 const canvasY = worldCenter.y + frame.canvas.h / 2 - scaledH / 2;

 // 2. Apply state updates
 ctx.actions.setImageCropBox(frame.id, asLocalShape({
 x: canvasX,
 y: canvasY,
 w: scaledW,
 h: scaledH
 }));

 // Close pan mode to focus on the crop box
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
 const children = allLayers.order.map(id => allLayers.byId[id]).filter(l => l.parentId === host.id);
 fullLayers.push(...children);
 });
 
 return fullLayers;
}
