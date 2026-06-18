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
 * CMD+J commands: Create new layers by copying or cutting selections.
 */
export const LayerCmdJCommands = {
  copyToLayer: {
    id: P.ADV_LAYER_CMDJ_COPY,
    name: 'Copy to Layer',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<void> => {
      const { activeFrame, activeLayer, state } = ctx;
      const isClipMode = state.interaction.interactionMode === 'clip';
      if (!activeFrame || !activeLayer || !isClipMode || activeLayer.type !== 'image') {
        ctx.actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      try {
        const latestLayer = ctx.actions.fast.latestLayer(activeFrame.id, activeLayer.id) || activeLayer;
        const hasSelection = activeFrame.imageCropBox && activeFrame.imageCropBox.rect.w > 0 && activeFrame.imageCropBox.rect.h > 0;

        if (hasSelection) {
          // With selection: copy selection
          const result = ctx.layers.fragmentToLayerLogical(activeFrame, latestLayer, 'Layer');
          if (!result) {
            ctx.actions.setInteraction({ selectionErrorPulse: Date.now() });
            return;
          }
          ctx.layers.addLayer(activeFrame.id, result.newLayer);
        } else {
          // Without selection: copy the entire layer
          const newName = ctx.layers.getNewLayerName(activeFrame.layers.order.map(id => activeFrame.layers.byId[id]), `${latestLayer.name} Copy`);
          const newLayer = ctx.layers.getNewLayer({
            ...latestLayer,
            id: undefined,
            name: newName,
            parentId: undefined
          });
          ctx.layers.addLayer(activeFrame.id, newLayer);
        }
      } catch (err) {
        console.error('[ClipCommands] Layer via Copy failed:', err);
      }
    },
    shortcut: { key: 'j', meta: true }
  } as EditorCommand<void, Promise<void>>,

  cutToLayer: {
    id: P.ADV_LAYER_CMDJ_CUT,
    name: 'Cut to Layer',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<void> => {
      const { activeFrame, activeLayer, actions, state } = ctx;
      const isClipMode = state.interaction.interactionMode === 'clip';
      if (!activeFrame || !activeLayer || !isClipMode || activeLayer.type !== 'image') {
        actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      try {
        const latestLayer = actions.fast.latestLayer(activeFrame.id, activeLayer.id) || activeLayer;
        const result = ctx.layers.fragmentToLayerLogical(activeFrame, latestLayer, 'Layer');
        if (!result) {
          actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        // Apply a hole mask to the original layer
        ctx.layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(activeLayer.id).applyMask(result.localShape, true);
        });

        ctx.layers.addLayer(activeFrame.id, result.newLayer);
      } catch (err) {
        console.error('[ClipCommands] Layer via Cut failed:', err);
      }
    },
    shortcut: { key: 'j', meta: true, shift: true }
  } as EditorCommand<void, Promise<void>>
};
