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

import { Layer, EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';

import { syncToCanvasOverlay } from './utils';

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

            const rect = layer.visibleShape?.rect || { x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h };
            const worldCenter = { x: layer.cx, y: layer.cy };

            syncToCanvasOverlay(ctx, frame, worldCenter, rect.w, rect.h);
        }
    } as EditorCommand<{ frameId?: string; layerId: string }, void>,

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

            syncToCanvasOverlay(ctx, frame, worldCenter, shape.rect.w, shape.rect.h);
        }
    } as EditorCommand<{ frameId?: string; layerId: string; maskId: string }, void>
};
