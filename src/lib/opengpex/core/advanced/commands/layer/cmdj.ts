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
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * CMD+J commands: Create new layers by copying or cutting selections.
 *
 * Uses the unified `fragmentToNewLayer` entry point which resolves the optimal
 * strategy (logical / vectorMask) based on selection type, layer
 * geometry, feather, and AA settings.
 */
export const LayerCmdJCommands = {
  copyToLayer: {
    id: P.ADV_LAYER_CMDJ_COPY,
    name: 'Copy to Layer',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: { feather?: number }): Promise<void> => {
      const { activeFrame, activeLayer, state } = ctx;
      const isClipMode = state.interaction.interactionMode === 'clip';

      if (!activeFrame || !activeLayer || !isClipMode || activeLayer.type !== 'image') {
        ctx.actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      try {
        const latestLayer = ctx.actions.fast.latestLayer(activeFrame.id, activeLayer.id) || activeLayer;
        const box = getClipBox(activeFrame);
        const feather = payload?.feather ?? 0;

        if (box) {
          const result = await ctx.layers.fragmentToNewLayer(activeFrame, latestLayer, { feather });
          if (!result) {
            ctx.actions.setInteraction({ selectionErrorPulse: Date.now() });
            return;
          }
          result.newLayer.locked = false;
          ctx.layers.addLayer(activeFrame.id, result.newLayer);
        } else {
          // No selection: duplicate entire layer
          const newName = ctx.layers.getNewLayerName(
            activeFrame.layers.order.map(id => activeFrame.layers.byId[id]), `${latestLayer.name} Copy`
          );
          const { id: _, hostId: _h, role: _r, locked: _l, interactive: _i, ...layerData } = latestLayer;
          const newLayer = ctx.layers.getNewLayer({ ...layerData, name: newName });
          ctx.layers.addLayer(activeFrame.id, newLayer);
        }
      } catch (err) {
        console.error('[ClipCommands] Layer via Copy failed:', err);
      }
    },
  } as EditorCommand<{ feather?: number } | undefined, Promise<void>>,

  cutToLayer: {
    id: P.ADV_LAYER_CMDJ_CUT,
    name: 'Cut to Layer',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: { feather?: number }): Promise<void> => {
      const { activeFrame, activeLayer, actions, state } = ctx;
      const isClipMode = state.interaction.interactionMode === 'clip';
      if (!activeFrame || !activeLayer || !isClipMode || activeLayer.type !== 'image') {
        actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      try {
        const latestLayer = actions.fast.latestLayer(activeFrame.id, activeLayer.id) || activeLayer;
        const box = getClipBox(activeFrame);
        if (!box) {
          actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        const feather = payload?.feather ?? 0;

        // Create fragment via unified strategy resolver (mode:'cut' generates sourceHole)
        const result = await ctx.layers.fragmentToNewLayer(activeFrame, latestLayer, { feather, mode: 'cut' });
        if (!result) {
          actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        // Punch a hole in the source layer using the pre-computed holeMask descriptor.
        if (result.holeMask) {
          const { shape, inverted, assocLayerId, feather: maskFeather, maskId } = result.holeMask;
          ctx.layers.updateLayer(activeFrame.id, (tx) => {
            tx.edit(activeLayer.id)
              .applyMask(shape, { maskId, assocLayerId, inverted, feather: maskFeather });
          });
        }

        // Add the fragment layer
        result.newLayer.locked = false; // New layers must never inherit lock state
        ctx.layers.addLayer(activeFrame.id, result.newLayer);
      } catch (err) {
        console.error('[ClipCommands] Layer via Cut failed:', err);
      }
    },
  } as EditorCommand<{ feather?: number } | undefined, Promise<void>>
};
