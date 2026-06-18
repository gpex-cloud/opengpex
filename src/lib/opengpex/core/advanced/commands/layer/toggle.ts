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

import { EditorContextValue, EditorCommand, Layer } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * LAYER_TOGGLE_COMMANDS: Handles batch visibility toggling of layers.
 */
export const LayerToggleCommands = {
  toggleAll: {
    id: P.ADV_LAYER_TOGGLE_ALL,
    name: 'Toggle All Layers',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId: string }): void => {
      const { state, actions } = ctx;
      const frame = state.frames.byId[payload.frameId];
      if (!frame) return;

      const layersArray = frame.layers.order.map(id => frame.layers.byId[id]);
      const anyVisible = layersArray.some(l => l.visible);
      
      const patches: Record<string, Partial<Layer>> = {};
      layersArray.forEach(l => { patches[l.id] = { visible: !anyVisible }; });
      actions.batchUpdateLayers(frame.id, patches);
    }
  } as EditorCommand<{ frameId: string }, void>,

  toggleOthers: {
    id: P.ADV_LAYER_TOGGLE_OTHERS,
    name: 'Toggle Other Layers',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId: string, activeLayerId: string }): void => {
      const { state, actions } = ctx;
      const frame = state.frames.byId[payload.frameId];
      if (!frame) return;

      const layersArray = frame.layers.order.map(id => frame.layers.byId[id]);
      const othersVisible = layersArray.some(l => l.id !== payload.activeLayerId && l.visible);
      
      const patches: Record<string, Partial<Layer>> = {};
      layersArray.forEach(l => {
        if (l.id === payload.activeLayerId) patches[l.id] = { visible: true };
        else patches[l.id] = { visible: !othersVisible };
      });
      actions.batchUpdateLayers(frame.id, patches);
    }
  } as EditorCommand<{ frameId: string, activeLayerId: string }, void>
};
