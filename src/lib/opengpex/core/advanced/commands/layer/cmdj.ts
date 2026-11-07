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
 * Insert a clip product directly above its source layer and, for Layer via
 * Cut, append the source mask in the same undo step.
 */
async function clipToNewLayer(
  ctx: EditorContextValue,
  mode: 'copyToLayer' | 'cutToLayer',
): Promise<void> {
  const { activeFrame, activeLayer, actions, state } = ctx;
  const isClipMode = state.interaction.interactionMode === 'clip';
  const latestLayer = (activeFrame && activeLayer)
    ? (actions.fast?.latestLayer?.(activeFrame.id, activeLayer.id) || activeLayer)
    : null;

  if (!activeFrame || !latestLayer || !isClipMode) {
    actions.setInteraction({ hud: { message: 'No editable layer selected', type: 'error' } });
    return;
  }
  // Layer via Cut edits the source (mask); Layer via Copy only reads it.
  if (mode === 'cutToLayer' && latestLayer.locked) {
    actions.setInteraction({ hud: { message: 'Layer is locked', type: 'error' } });
    return;
  }

  const result = await ctx.layers.clipFragment(activeFrame, latestLayer, { mode });
  if (!result.newLayer) {
    if (result.hud) actions.setInteraction({ hud: { message: result.hud, type: 'error' } });
    return;
  }

  if (result.sourceMask) {
    const sourceMask = result.sourceMask;
    ctx.layers.updateLayer(activeFrame.id, (tx) => {
      tx.edit(latestLayer.id).patch({
        vectorMasks: [...(latestLayer.vectorMasks || []), sourceMask],
      });
    });
  }
  const insertAt = ctx.layers.getInsertIndexAbove(activeFrame, latestLayer.id);
  ctx.layers.addLayer(activeFrame.id, result.newLayer, insertAt);
}

/**
 * CMD+J commands: create a new layer from the selection (or the whole layer)
 * by copying or cutting. Routing for every layer type lives in the clip
 * decision table behind `LayerService.clipFragment`.
 */
export const LayerCmdJCommands = {
  copyToLayer: {
    id: P.ADV_LAYER_CMDJ_COPY,
    name: 'Copy to Layer',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<void> => {
      try {
        await clipToNewLayer(ctx, 'copyToLayer');
      } catch (err) {
        console.error('[ClipCommands] Layer via Copy failed:', err);
      }
    },
  } as EditorCommand<undefined, Promise<void>>,

  cutToLayer: {
    id: P.ADV_LAYER_CMDJ_CUT,
    name: 'Cut to Layer',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<void> => {
      try {
        await clipToNewLayer(ctx, 'cutToLayer');
      } catch (err) {
        console.error('[ClipCommands] Layer via Cut failed:', err);
      }
    },
  } as EditorCommand<{ feather?: number } | undefined, Promise<void>>
};
