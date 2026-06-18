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

import { EditorContextValue, EditorCommand, BitmapMask, LocalRect } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * BITMAP_MASK_COMMANDS: Bitmap mask management command set.
 * Contains: adding, updating, toggling, removing, and clearing bitmap masks.
 */
export const LayerBitmapMaskCommands = {
  addBitmapMask: {
    id: P.ADV_LAYER_BITMAP_MASK_ADD,
    name: 'Add Bitmap Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; src: string; assetId: string; bounds: LocalRect }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId || !payload.src || !payload.assetId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer) return;

      const newMask = LayerFactory.getNewBitmapMask(payload.src, payload.assetId, payload.bounds);
      actions.updateLayer(frame.id, payload.layerId, {
        bitmapMasks: [...(layer.bitmapMasks || []), newMask]
      });
    }
  } as EditorCommand<{ frameId?: string; layerId: string; src: string; assetId: string; bounds: LocalRect }, void>,

  updateBitmapMask: {
    id: P.ADV_LAYER_BITMAP_MASK_UPDATE,
    name: 'Update Bitmap Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; maskId: string; patch: Partial<BitmapMask> }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId || !payload.maskId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer || !layer.bitmapMasks) return;

      const nextMasks = layer.bitmapMasks.map(m =>
        m.id === payload.maskId ? { ...m, ...payload.patch } : m
      );
      actions.updateLayer(frame.id, payload.layerId, { bitmapMasks: nextMasks });
    }
  } as EditorCommand<{ frameId?: string; layerId: string; maskId: string; patch: Partial<BitmapMask> }, void>,

  toggleBitmapMask: {
    id: P.ADV_LAYER_BITMAP_MASK_TOGGLE,
    name: 'Toggle Bitmap Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; maskId: string }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId || !payload.maskId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer || !layer.bitmapMasks) return;

      const nextMasks = layer.bitmapMasks.map(m =>
        m.id === payload.maskId ? { ...m, enabled: !m.enabled } : m
      );
      actions.updateLayer(frame.id, payload.layerId, { bitmapMasks: nextMasks });
    }
  } as EditorCommand<{ frameId?: string; layerId: string; maskId: string }, void>,

  removeBitmapMask: {
    id: P.ADV_LAYER_BITMAP_MASK_REMOVE,
    name: 'Remove Bitmap Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; maskId: string }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId || !payload.maskId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer || !layer.bitmapMasks) return;

      const nextMasks = layer.bitmapMasks.filter(m => m.id !== payload.maskId);
      actions.updateLayer(frame.id, payload.layerId, { bitmapMasks: nextMasks });
    }
  } as EditorCommand<{ frameId?: string; layerId: string; maskId: string }, void>,

  clearBitmapMasks: {
    id: P.ADV_LAYER_BITMAP_MASK_CLEAR,
    name: 'Clear All Bitmap Masks',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer) return;

      actions.updateLayer(frame.id, payload.layerId, { bitmapMasks: [] });
    }
  } as EditorCommand<{ frameId?: string; layerId: string }, void>,
};
