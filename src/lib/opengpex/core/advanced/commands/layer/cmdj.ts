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
import { getClipBox } from '@opengpex/editor/core/helpers/selection';

/**
 * Insert a clip product directly above its source layer and, for Layer via
 * Cut, append the source mask in the same undo step.
 */
async function clipToNewLayer(
  ctx: EditorContextValue,
  mode: 'copyToLayer' | 'cutToLayer',
  /** Caller-resolved selection policy (the plugin wrapper reads the user
   *  preference — core commands never read plugin config). Default: clear
   *  on cutToLayer, the Photoshop behavior. */
  keepClipBoxAfter = false,
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

  // Selection lifecycle on landing — same rule as the clipboard family: a
  // Cut to Layer dissolves the selection unless the preference keeps the
  // ants, and a KEPT selection converges onto the inserted fragment's cut
  // outline (Copy to Layer always converges — the source is untouched and
  // the ants should describe the new fragment).
  if (mode === 'cutToLayer' && !keepClipBoxAfter) {
    actions.updateFrame(activeFrame.id, { confinement: null });
  } else if (result.newLayer && getClipBox(activeFrame) && result.confinement) {
    // Converge only when a selection existed (same guard as the clipboard
    // family); the projection rode the fragment result from the core.
    actions.updateFrame(activeFrame.id, { confinement: result.confinement });
  }
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
    execute: async (ctx: EditorContextValue, payload?: { keepClipBoxAfter?: boolean }): Promise<void> => {
      try {
        await clipToNewLayer(ctx, 'cutToLayer', payload?.keepClipBoxAfter);
      } catch (err) {
        console.error('[ClipCommands] Layer via Cut failed:', err);
      }
    },
  } as EditorCommand<{ keepClipBoxAfter?: boolean; feather?: number } | undefined, Promise<void>>
};
