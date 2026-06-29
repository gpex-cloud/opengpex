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
import type { TextLayerData } from '@opengpex/editor/core/types/models';
import * as P from './protocols';

// ─── Commands ──────────────────────────────────────────────────────────────────

/**
 * cmd.place: Places a new text layer and enters editing state
 *
 * undoable: true → Automatically establish SIGNAL_COMMIT undo baseline before execution.
 * Undo will remove the newly created layer completely in one step.
 */
const placeCommand: EditorCommand<{ frameId: string; layer: Layer }, void> = {
  id: P.CMD_PLACE,
  name: 'Place Text Layer',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layer: Layer }) => {
    // Pass through complete pipeline via LayerService.addLayer (expandLayers + cascade calculation),
    // ensuring the text layer supports subsequent operations like peel that generate child layers.
    ctx.layers.addLayer(payload.frameId, payload.layer);
    ctx.layers.activate(payload.frameId, payload.layer.id);
    ctx.scoped!.setSignal(P.SIGNAL_EDITING_TEXT_LAYER_ID, payload.layer.id);
    ctx.scoped!.setSignal(P.SIGNAL_SESSION_TYPE, 'create');
  },
};

/**
 * cmd.edit_start: Activates an existing text layer and enters editing state
 *
 * undoable: false → No automatic checkpoint. The editing session (ModifySession)
 * manages its own snapshot and creates a checkpoint only at commit time when
 * actual changes are detected. Cancel restores from snapshot with zero undo impact.
 */
const editStartCommand: EditorCommand<{ frameId: string; layerId: string }, void> = {
  id: P.CMD_EDIT_START,
  name: 'Start Text Editing',
  undoable: false,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string }) => {
    ctx.actions.setActiveLayer(payload.frameId, payload.layerId);
    ctx.scoped!.setSignal(P.SIGNAL_EDITING_TEXT_LAYER_ID, payload.layerId);
    ctx.scoped!.setSignal(P.SIGNAL_SESSION_TYPE, 'modify');
  },
};

/**
 * cmd.update_properties: Updates text layer style attributes
 *
 * undoable: true → Automatically establish SIGNAL_COMMIT undo baseline before execution.
 * Only used for attribute modifications in non-editing state (editing state modifications should go directly to updateLayer to avoid fragmented snapshots).
 */
const updatePropertiesCommand: EditorCommand<{ frameId: string; layerId: string; patch: Partial<TextLayerData> }, void> = {
  id: P.CMD_UPDATE_PROPERTIES,
  name: 'Update Text Properties',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string; patch: Partial<TextLayerData> }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    const layer = frame?.layers.byId[payload.layerId];
    if (!frame || !layer || !layer.textData) return;

    ctx.actions.updateLayer(payload.frameId, payload.layerId, {
      textData: {
        ...layer.textData,
        ...payload.patch,
      },
    });
  },
};

/**
 * cmd.modify_commit: Commits a modify session with full layer patch
 *
 * undoable: true → Creates the undo baseline automatically (SIGNAL_COMMIT).
 * Called AFTER restoring the original snapshot so that undo reverts to pre-edit state.
 * The payload contains the full final layer state to apply.
 */
const modifyCommitCommand: EditorCommand<{ frameId: string; layerId: string; patch: Partial<Layer> }, void> = {
  id: P.CMD_MODIFY_COMMIT,
  name: 'Commit Text Modification',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string; patch: Partial<Layer> }) => {
    ctx.actions.updateLayer(payload.frameId, payload.layerId, payload.patch);
  },
};

// ─── Export ────────────────────────────────────────────────────────────────────

export const TEXT_OVERLAY_COMMANDS = [
  placeCommand,
  editStartCommand,
  updatePropertiesCommand,
  modifyCommitCommand,
];
