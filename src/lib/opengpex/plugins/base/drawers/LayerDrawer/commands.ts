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

import { Layer, EditorContextValue, EditorCommand, asLocalShape, LayerBlendMode } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';

import { commitRefocusToOverlay, RefocusTarget } from './utils';

import * as P from './protocols';

/**
 * LAYER_COMMANDS: Declarative command configurations.
 */
export const LAYER_COMMANDS = {
    reorder: {
        id: P.CMD_REORDER,
        name: 'Reorder Layers',
        undoable: true,
        execute: (ctx: EditorContextValue, payload: { frameId: string; layers: Layer[] }) => {
            if (payload.frameId && payload.layers) {
                ctx.actions.setLayers(payload.frameId, payload.layers);
            }
        }
    } as EditorCommand<{ frameId: string; layers: Layer[] }, void>,

    remove: {
        id: P.CMD_REMOVE,
        name: 'Remove Layer',
        undoable: true,
        execute: (ctx: EditorContextValue, payload?: { frameId?: string; layerId?: string }) => {
            const frameId = payload?.frameId || ctx.activeFrame?.id;
            const layerId = payload?.layerId || ctx.activeLayer?.id;
            if (frameId && layerId) ctx.layers.removeLayers(frameId, layerId);
        }
    } as EditorCommand<{ frameId?: string; layerId?: string }, void>,

    toggleVisibility: {
        id: P.CMD_VISIBILITY,
        name: 'Toggle Layer Visibility',
        execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; visible: boolean }) => {
            const frameId = payload.frameId || ctx.activeFrame?.id;
            if (frameId && payload.layerId) {
                ctx.actions.updateLayer(frameId, payload.layerId, { visible: payload.visible });
            }
        }
    } as EditorCommand<{ frameId?: string; layerId: string; visible: boolean }, void>,

    toggleLock: {
        id: P.CMD_LOCK,
        name: 'Toggle Layer Lock',
        execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; locked: boolean }) => {
            const frameId = payload.frameId || ctx.activeFrame?.id;
            if (frameId && payload.layerId) {
                ctx.actions.updateLayer(frameId, payload.layerId, { locked: payload.locked });
            }
        }
    } as EditorCommand<{ frameId?: string; layerId: string; locked: boolean }, void>,

    rename: {
        id: P.CMD_RENAME,
        name: 'Rename Layer',
        undoable: true,
        execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; name: string }) => {
            const frameId = payload.frameId || ctx.activeFrame?.id;
            if (frameId && payload.layerId && payload.name) {
                ctx.actions.updateLayer(frameId, payload.layerId, { name: payload.name });
            }
        }
    } as EditorCommand<{ frameId?: string; layerId: string; name: string }, void>,

    syncToOverlay: {
        id: P.CMD_SYNC_TO_OVERLAY,
        name: 'Snap Layer to Overlay',
        execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string }) => {
            const frameId = payload.frameId || ctx.activeFrame?.id;
            if (!frameId || !payload.layerId) return;

            const frame = ctx.state.frames.byId[frameId];
            const layer = frame?.layers.byId[payload.layerId];
            if (!frame || !layer) return;

            const shape = layer.visibleShape;
            const rect = shape?.rect || { x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h };
            const shapeType = shape?.type || 'rect';

            // Resolve the RefocusTarget based on shape type
            let target: RefocusTarget;

            if (shapeType === 'path' && shape?.pathData) {
                // Irregular shape: decompose pathData → polygon → project to frame space
                const rings = ctx.geometry.point2d.shapeToPoint2D(shape);
                if (rings.length === 0) return;

                const localPoly = ctx.geometry.point2d.point2dToLocalPolygon(rings, shape.antiAliased !== false);
                const framePoly = ctx.geometry.polygon.layerLocalToFrameLocal(localPoly, layer, frame);

                // Use the recorded source clip tool if available, otherwise default to 'lasso'
                const sourceClipTool = (layer.metadata?.clipTool as string) || 'lasso';
                const clipToolId = (sourceClipTool === 'wand' || sourceClipTool === 'sam') ? sourceClipTool : 'lasso';

                target = { regular: false, clipToolId, polygon: framePoly };
            } else {
                // Regular shape (rect / circle): project center through world matrix
                const M = ctx.geometry.transform.getLayerWorldMatrix(layer);
                const localCenter = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
                const worldCenter = M.apply(localCenter);

                const clipToolId = shapeType === 'circle' ? 'ellipse' as const : 'rect' as const;
                const canvasX = worldCenter.x + frame.canvas.w / 2 - rect.w / 2;
                const canvasY = worldCenter.y + frame.canvas.h / 2 - rect.h / 2;

                target = { regular: true, clipToolId, shapeType, canvasX, canvasY, w: rect.w, h: rect.h };
            }

            // Unified commit
            commitRefocusToOverlay(ctx, frame, target);
        }
    } as EditorCommand<{ frameId?: string; layerId: string }, void>,

    addBlankLayer: {
        id: P.CMD_ADD_BLANK_LAYER,
        name: 'New Blank Layer',
        undoable: true,
        execute: (ctx: EditorContextValue) => {
            const { activeFrame } = ctx;
            if (!activeFrame) return;

            const layersArray = activeFrame.layers.order.map(id => activeFrame.layers.byId[id]);
            const hostLayers = LayerFactory.getHostLayers(layersArray);
            const name = LayerFactory.getNewLayerName(hostLayers, 'Layer');

            const newLayer = LayerFactory.getNewLayer({
                name,
                type: 'image',
                bounding: activeFrame.canvas,
                visibleShape: asLocalShape({ x: 0, y: 0, w: activeFrame.canvas.w, h: activeFrame.canvas.h }),
                cx: 0,
                cy: 0,
                locked: false,
            });

            // Insert above the currently active layer
            const activeIdx = hostLayers.findIndex(l => l.id === activeFrame.activeLayerId);
            ctx.layers.addLayer(activeFrame.id, newLayer, activeIdx >= 0 ? activeIdx + 1 : undefined);
        }
    } as EditorCommand<void, void>,

    duplicateLayer: {
        id: P.CMD_DUPLICATE_LAYER,
        name: 'Duplicate Layer',
        undoable: true,
        execute: (ctx: EditorContextValue, payload?: { layerId?: string }) => {
            const { activeFrame } = ctx;
            if (!activeFrame) return;

            const targetId = payload?.layerId || activeFrame.activeLayerId;
            if (!targetId) return;

            const layer = activeFrame.layers.byId[targetId];
            if (!layer || layer.hostId) return; // Only allow duplicating host layers

            const layersArray = activeFrame.layers.order.map(id => activeFrame.layers.byId[id]);
            const hostLayers = LayerFactory.getHostLayers(layersArray);
            const newName = LayerFactory.getNewLayerName(hostLayers, `${layer.name} Copy`);

            const { id: _id, hostId: _pid, role: _role, ...layerData } = layer;
            const newLayer = LayerFactory.getNewLayer({
                ...layerData,
                name: newName,
                locked: false, // Duplicated layer is always unlocked
            });

            // Insert above the original layer
            const insertIdx = hostLayers.findIndex(l => l.id === targetId);
            ctx.layers.addLayer(activeFrame.id, newLayer, insertIdx >= 0 ? insertIdx + 1 : undefined);
        }
    } as EditorCommand<{ layerId?: string } | undefined, void>,

    syncMaskToOverlay: {
        id: P.CMD_MASK_SYNC_TO_OVERLAY,
        name: 'Snap Mask to Overlay',
        execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; maskId: string }) => {
            const frameId = payload.frameId || ctx.state.activeFrameId;
            if (!frameId) return;

            const frame = ctx.state.frames.byId[frameId];
            const layer = frame?.layers.byId[payload.layerId];
            if (!frame || !layer || !layer.vectorMasks) return;

            const mask = layer.vectorMasks.find(m => m.id === payload.maskId);
            if (!mask) return;

            const { shape } = mask;
            const latestLayer = ctx.actions.fast.latestLayer(frameId, payload.layerId) || layer;
            const M = ctx.geometry.transform.getLayerWorldMatrix(latestLayer);

            const maskLocalCenter = {
                x: shape.rect.x + shape.rect.w / 2,
                y: shape.rect.y + shape.rect.h / 2
            };
            const worldCenter = M.apply(maskLocalCenter);

            // Resolve target based on mask shape type
            let target: RefocusTarget;

            if (shape.type === 'path' && shape.pathData) {
                const rings = ctx.geometry.point2d.shapeToPoint2D(shape);
                if (rings.length === 0) return;

                const localPoly = ctx.geometry.point2d.point2dToLocalPolygon(rings, shape.antiAliased !== false);
                const framePoly = ctx.geometry.polygon.layerLocalToFrameLocal(localPoly, latestLayer, frame);

                // Read source clip tool from parent layer metadata
                const sourceClipTool = (layer.metadata?.clipTool as string) || 'lasso';
                const clipToolId = (sourceClipTool === 'wand' || sourceClipTool === 'sam') ? sourceClipTool : 'lasso';

                target = { regular: false, clipToolId, polygon: framePoly };
            } else {
                const clipToolId = shape.type === 'circle' ? 'ellipse' as const : 'rect' as const;
                const canvasX = worldCenter.x + frame.canvas.w / 2 - shape.rect.w / 2;
                const canvasY = worldCenter.y + frame.canvas.h / 2 - shape.rect.h / 2;

                target = { regular: true, clipToolId, shapeType: shape.type, canvasX, canvasY, w: shape.rect.w, h: shape.rect.h };
            }

            commitRefocusToOverlay(ctx, frame, target);
        }
    } as EditorCommand<{ frameId?: string; layerId: string; maskId: string }, void>,

    setBlendMode: {
        id: P.CMD_SET_BLEND_MODE,
        name: 'Set Blend Mode',
        undoable: true,
        execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId?: string; blendMode: LayerBlendMode }) => {
            const frameId = payload.frameId || ctx.activeFrame?.id;
            const layerId = payload.layerId || ctx.activeLayer?.id;
            if (frameId && layerId) {
                ctx.actions.updateLayer(frameId, layerId, { blendMode: payload.blendMode });
            }
        }
    } as EditorCommand<{ frameId?: string; layerId?: string; blendMode: LayerBlendMode }, void>,

    setLayerOpacity: {
        id: P.CMD_SET_LAYER_OPACITY,
        name: 'Set Layer Opacity',
        undoable: true,
        execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId?: string; opacity: number }) => {
            const frameId = payload.frameId || ctx.activeFrame?.id;
            const layerId = payload.layerId || ctx.activeLayer?.id;
            if (frameId && layerId) {
                ctx.actions.updateLayer(frameId, layerId, { opacity: payload.opacity });
            }
        }
    } as EditorCommand<{ frameId?: string; layerId?: string; opacity: number }, void>,

    setLayerFill: {
        id: P.CMD_SET_LAYER_FILL,
        name: 'Set Layer Fill',
        undoable: true,
        execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId?: string; fill: number }) => {
            const frameId = payload.frameId || ctx.activeFrame?.id;
            const layerId = payload.layerId || ctx.activeLayer?.id;
            if (frameId && layerId) {
                ctx.actions.updateLayer(frameId, layerId, { fill: payload.fill });
            }
        }
    } as EditorCommand<{ frameId?: string; layerId?: string; fill: number }, void>
};
