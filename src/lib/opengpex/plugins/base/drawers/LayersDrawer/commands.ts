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
export const LAYERS_COMMANDS = {
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
            if (!frameId || !layerId) return;

            const frame = ctx.state.frames.byId[frameId];
            if (!frame) return;

            const layer = frame.layers.byId[layerId];
            if (layer?.type === 'group') {
                // Deleting a group → also delete all children that belong to this group
                const childIds = frame.layers.order.filter(id => frame.layers.byId[id].groupId === layerId);
                ctx.layers.removeLayers(frameId, [layerId, ...childIds]);
            } else {
                ctx.layers.removeLayers(frameId, layerId);
            }
        }
    } as EditorCommand<{ frameId?: string; layerId?: string }, void>,

    toggleVisibility: {
        id: P.CMD_VISIBILITY,
        name: 'Toggle Layer Visibility',
        execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; visible: boolean }) => {
            const frameId = payload.frameId || ctx.activeFrame?.id;
            if (!frameId || !payload.layerId) return;

            const frame = ctx.state.frames.byId[frameId];
            const layer = frame?.layers.byId[payload.layerId];

            // Group batch operation: toggling a group toggles all its children
            if (layer?.type === 'group' && frame) {
                const patches: Record<string, Partial<Layer>> = { [payload.layerId]: { visible: payload.visible } };
                for (const id of frame.layers.order) {
                    if (frame.layers.byId[id].groupId === payload.layerId) {
                        patches[id] = { visible: payload.visible };
                    }
                }
                ctx.actions.batchUpdateLayers(frameId, patches);
            } else {
                ctx.actions.updateLayer(frameId, payload.layerId, { visible: payload.visible });
            }
        }
    } as EditorCommand<{ frameId?: string; layerId: string; visible: boolean }, void>,

    toggleLock: {
        id: P.CMD_LOCK,
        name: 'Toggle Layer Lock',
        execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; locked: boolean }) => {
            const frameId = payload.frameId || ctx.activeFrame?.id;
            if (!frameId || !payload.layerId) return;

            const frame = ctx.state.frames.byId[frameId];
            const layer = frame?.layers.byId[payload.layerId];

            // Group batch operation: toggling a group toggles all its children
            if (layer?.type === 'group' && frame) {
                const patches: Record<string, Partial<Layer>> = { [payload.layerId]: { locked: payload.locked } };
                for (const id of frame.layers.order) {
                    if (frame.layers.byId[id].groupId === payload.layerId) {
                        patches[id] = { locked: payload.locked };
                    }
                }
                ctx.actions.batchUpdateLayers(frameId, patches);
            } else {
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

            const activeLayer = activeFrame.activeLayerId ? activeFrame.layers.byId[activeFrame.activeLayerId] : undefined;
            const targetGroupId = activeLayer?.type === 'group' ? activeLayer.id : activeLayer?.groupId;

            const newLayer = LayerFactory.getNewLayer({
                name,
                type: 'image',
                groupId: targetGroupId,
                bounding: activeFrame.canvas,
                visibleShape: asLocalShape({ x: 0, y: 0, w: activeFrame.canvas.w, h: activeFrame.canvas.h }),
                cx: 0,
                cy: 0,
                locked: false,
            });

            // Insert above the currently active layer (or highest child if group)
            const insertAt = LayerFactory.getInsertIndexAbove(activeFrame, activeFrame.activeLayerId);
            ctx.layers.addLayer(activeFrame.id, newLayer, insertAt);
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

            // Strip assocMaskId from metadata: a duplicate is not the same cut fragment
            // (the hole mask on the source only corresponds to the original layer).
            // Keep sourceLayerId for lineage tracking (degrades to copy semantics).
            let metadata = layerData.metadata;
            if (metadata?.assocMaskId) {
                const { assocMaskId: _, ...restMeta } = metadata;
                metadata = restMeta;
            }

            const newLayer = LayerFactory.getNewLayer({
                ...layerData,
                metadata,
                name: newName,
                vectorMasks: LayerFactory.cleanInheritedMasks(layerData.vectorMasks),
                bitmapMasks: LayerFactory.cleanInheritedMasks(layerData.bitmapMasks),
                locked: false, // Duplicated layer is always unlocked
            });

            // Insert directly above the original layer
            const insertAt = LayerFactory.getInsertIndexAbove(activeFrame, targetId);
            ctx.layers.addLayer(activeFrame.id, newLayer, insertAt);
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
    } as EditorCommand<{ frameId?: string; layerId?: string; fill: number }, void>,

    /**
     * CMD_OPACITY_SHORTCUT — Number keys 1-0 set layer opacity in 10% steps.
     *
     * Photoshop convention: 1=10%, 2=20%, ..., 9=90%, 0=100%.
     * Guard: no-op in clip mode (reserved for future tool switching).
     *
     * Implementation: a single command with 10 shortcut bindings. The HotkeyManager
     * passes the matched shortcut's key through to the command payload via
     * `_shortcutKey`. We map the key character to the opacity percentage.
     */
    opacityShortcut: {
        id: P.CMD_OPACITY_SHORTCUT,
        name: 'Set Opacity via Number Key',
        category: 'Layers',
        undoable: true,
        shortcuts: [
            { key: '1' }, { key: '2' }, { key: '3' }, { key: '4' }, { key: '5' },
            { key: '6' }, { key: '7' }, { key: '8' }, { key: '9' }, { key: '0' }
        ],
        execute: (ctx: EditorContextValue, payload: { _shortcutKey?: string }) => {
            const frameId = ctx.activeFrame?.id;
            const layerId = ctx.activeLayer?.id;
            if (!frameId || !layerId) return;

            // Map key to opacity: '1'→0.1, '2'→0.2, ..., '9'→0.9, '0'→1.0
            const key = payload?._shortcutKey;
            if (!key) return;
            const digit = parseInt(key, 10);
            if (isNaN(digit)) return;
            const opacity = digit === 0 ? 1 : digit * 0.1;

            ctx.actions.updateLayer(frameId, layerId, { opacity });
        }
    } as EditorCommand<{ _shortcutKey?: string }, void>,

    // ─── Layer Group Commands (Phase 1) ──────────────────────────────────────────

    createGroup: {
        id: P.CMD_CREATE_GROUP,
        name: 'Create Group',
        category: 'Layers',
        undoable: true,
        shortcuts: [{ key: 'g', meta: true }],
        execute: (ctx: EditorContextValue, payload?: { layerIds?: string[] }) => {
            const { activeFrame } = ctx;
            if (!activeFrame) return;

            const layersArray = activeFrame.layers.order.map(id => activeFrame.layers.byId[id]);
            const hostLayers = LayerFactory.getHostLayers(layersArray);

            // Determine which layers to group
            const selectedIds = payload?.layerIds;
            const hasSelection = selectedIds && selectedIds.length > 0;

            // Smart naming
            const groupName = LayerFactory.getNewLayerName(hostLayers, 'Group');
            const group = LayerFactory.getNewGroup({ name: groupName });

            if (hasSelection) {
                // Group selected layers: insert group right above the topmost selected layer
                // Filter out any group layers from selection (groups can't be nested)
                const validIds = selectedIds.filter(id => {
                    const l = activeFrame.layers.byId[id];
                    return l && l.type !== 'group' && !l.hostId;
                });
                if (validIds.length === 0) return;

                // Assign groupId to selected layers
                const patches: Record<string, Partial<Layer>> = {};
                for (const id of validIds) {
                    patches[id] = { groupId: group.id };
                }
                ctx.actions.batchUpdateLayers(activeFrame.id, patches);

                // Find the topmost selected layer in the flat order, skip past its children
                const orderArr = activeFrame.layers.order;
                const topIdx = Math.max(...validIds.map(id => orderArr.indexOf(id)));
                const topLayerId = orderArr[topIdx];
                let insertAt = topIdx + 1;
                while (insertAt < orderArr.length && activeFrame.layers.byId[orderArr[insertAt]]?.hostId === topLayerId) {
                    insertAt++;
                }
                ctx.layers.addLayer(activeFrame.id, group, insertAt);
            } else {
                // No selection: create empty group above the active layer
                const orderArr = activeFrame.layers.order;
                const activeId = activeFrame.activeLayerId;
                const activeOrderIdx = activeId ? orderArr.indexOf(activeId) : -1;

                if (activeOrderIdx < 0) {
                    ctx.layers.addLayer(activeFrame.id, group);
                    return;
                }

                // Skip past any children (exchange/frag) of the active layer
                let insertAt = activeOrderIdx + 1;
                while (insertAt < orderArr.length && activeFrame.layers.byId[orderArr[insertAt]]?.hostId === activeId) {
                    insertAt++;
                }
                ctx.layers.addLayer(activeFrame.id, group, insertAt);
            }
        }
    } as EditorCommand<{ layerIds?: string[] } | undefined, void>,

    ungroupLayers: {
        id: P.CMD_UNGROUP_LAYERS,
        name: 'Ungroup Layers',
        category: 'Layers',
        undoable: true,
        execute: (ctx: EditorContextValue, payload: { groupId: string }) => {
            const { activeFrame } = ctx;
            if (!activeFrame) return;

            const group = activeFrame.layers.byId[payload.groupId];
            if (!group || group.type !== 'group') return;

            // Clear groupId from all child layers
            const patches: Record<string, Partial<Layer>> = {};
            for (const id of activeFrame.layers.order) {
                const l = activeFrame.layers.byId[id];
                if (l.groupId === payload.groupId) {
                    patches[id] = { groupId: undefined };
                }
            }

            if (Object.keys(patches).length > 0) {
                ctx.actions.batchUpdateLayers(activeFrame.id, patches);
            }

            // Remove the group layer itself
            ctx.layers.removeLayers(activeFrame.id, payload.groupId);
        }
    } as EditorCommand<{ groupId: string }, void>,

    toggleGroupCollapse: {
        id: P.CMD_TOGGLE_GROUP_COLLAPSE,
        name: 'Toggle Group Collapse',
        execute: (ctx: EditorContextValue, payload: { frameId?: string; groupId: string; collapsed?: boolean }) => {
            const frameId = payload.frameId || ctx.activeFrame?.id;
            if (!frameId) return;

            const frame = ctx.state.frames.byId[frameId];
            if (!frame) return;

            const group = frame.layers.byId[payload.groupId];
            if (!group || group.type !== 'group') return;

            const newCollapsed = payload.collapsed !== undefined ? payload.collapsed : !group.collapsed;
            ctx.actions.updateLayer(frameId, payload.groupId, { collapsed: newCollapsed });
        }
    } as EditorCommand<{ frameId?: string; groupId: string; collapsed?: boolean }, void>,

    moveToGroup: {
        id: P.CMD_MOVE_TO_GROUP,
        name: 'Move to Group',
        undoable: true,
        execute: (ctx: EditorContextValue, payload: { layerIds: string[]; groupId: string }) => {
            const { activeFrame } = ctx;
            if (!activeFrame) return;

            const group = activeFrame.layers.byId[payload.groupId];
            if (!group || group.type !== 'group') return;

            // 过滤：只允许非 group、非子层（无 hostId）的图层移入组
            const validIds = payload.layerIds.filter(id => {
                const l = activeFrame.layers.byId[id];
                return l && l.type !== 'group' && !l.hostId;
            });
            if (validIds.length === 0) return;

            const patches: Record<string, Partial<Layer>> = {};
            for (const id of validIds) {
                patches[id] = { groupId: payload.groupId };
            }
            ctx.actions.batchUpdateLayers(activeFrame.id, patches);
        }
    } as EditorCommand<{ layerIds: string[]; groupId: string }, void>,

    moveOutOfGroup: {
        id: P.CMD_MOVE_OUT_OF_GROUP,
        name: 'Move out of Group',
        undoable: true,
        execute: (ctx: EditorContextValue, payload: { layerIds: string[] }) => {
            const { activeFrame } = ctx;
            if (!activeFrame) return;

            const validIds = payload.layerIds.filter(id => {
                const l = activeFrame.layers.byId[id];
                return l && l.groupId;
            });
            if (validIds.length === 0) return;

            const patches: Record<string, Partial<Layer>> = {};
            for (const id of validIds) {
                patches[id] = { groupId: undefined };
            }
            ctx.actions.batchUpdateLayers(activeFrame.id, patches);
        }
    } as EditorCommand<{ layerIds: string[] }, void>
};
