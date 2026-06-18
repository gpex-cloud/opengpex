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

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * MASK_COMMANDS: Mask management command set.
 * Contains: toggling, inverting, removing, and clearing masks.
 */
export const LayerMaskCommands = {
  toggleMask: {
    id: P.ADV_LAYER_MASK_TOGGLE,
    name: 'Toggle Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string, layerId: string, maskId: string }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId || !payload.maskId) {
        console.warn('[MaskCommands] Toggle failed: Missing payload', payload);
        return;
      }
      
      // Robust Frame lookup: directly scan frames containing this layer ID
      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) {
        console.warn('[MaskCommands] Toggle failed: Frame not found for layer', payload.layerId);
        return;
      }

      const layer = frame.layers.byId[payload.layerId];
      if (!layer || !layer.vectorMasks) {
        console.warn('[MaskCommands] Toggle failed: Layer or vectorMasks not found', payload.layerId);
        return;
      }

      const mask = layer.vectorMasks.find(m => m.id === payload.maskId);
      if (!mask || mask.reserved) return;

      const nextMasks = layer.vectorMasks.map(m =>
        m.id === payload.maskId ? { ...m, enabled: !m.enabled } : m
      );
      
      console.log(`[MaskCommands] Toggling mask ${payload.maskId} on layer ${payload.layerId}`);
      actions.updateLayer(frame.id, layer.id, { vectorMasks: nextMasks });
    }
  } as EditorCommand<{ frameId?: string, layerId: string, maskId: string }, void>,

  invertMask: {
    id: P.ADV_LAYER_MASK_INVERT,
    name: 'Invert All Masks',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string, layerId: string }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer || !layer.vectorMasks || layer.vectorMasks.length === 0) return;

      // Logic synchronization: if any unlocked forward (non-inverted) mask exists, invert all unlocked masks; otherwise, revert all to forward
      const unlockedMasks = layer.vectorMasks.filter(m => !m.reserved);
      if (unlockedMasks.length === 0) return;

      const shouldInvertAll = unlockedMasks.some(m => !m.inverted);
      const nextMasks = layer.vectorMasks.map(m => 
        m.reserved ? m : { ...m, inverted: shouldInvertAll }
      );
      
      console.log(`[MaskCommands] Inverting all unlocked masks on layer ${payload.layerId} to: ${shouldInvertAll}`);
      actions.updateLayer(frame.id, layer.id, { vectorMasks: nextMasks });
    }
  } as EditorCommand<{ frameId?: string, layerId: string }, void>,

  removeMask: {
    id: P.ADV_LAYER_MASK_REMOVE,
    name: 'Remove Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string, layerId: string, maskId: string }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId || !payload.maskId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer || !layer.vectorMasks) return;

      const mask = layer.vectorMasks.find(m => m.id === payload.maskId);
      if (!mask || mask.reserved) return;

      const nextMasks = layer.vectorMasks.filter(m => m.id !== payload.maskId);
      
      console.log(`[MaskCommands] Removing mask ${payload.maskId} from layer ${payload.layerId}`);
      actions.updateLayer(frame.id, layer.id, { vectorMasks: nextMasks });
    }
  } as EditorCommand<{ frameId?: string, layerId: string, maskId: string }, void>,

  clearMasks: {
    id: P.ADV_LAYER_MASK_CLEAR,
    name: 'Clear All Masks',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string, layerId: string }): void => {
      const { state, actions } = ctx;
      const frameId = payload.frameId || state.activeFrameId;
      const frame = (frameId ? state.frames.byId[frameId] : undefined) || state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;
      const layer = frame.layers.byId[payload.layerId];
      if (!layer || !layer.vectorMasks) return;

      const nextMasks = layer.vectorMasks.filter(m => m.reserved);
      actions.updateLayer(frame.id, payload.layerId, { vectorMasks: nextMasks });
    }
  } as EditorCommand<{ frameId?: string, layerId: string }, void>,
};
