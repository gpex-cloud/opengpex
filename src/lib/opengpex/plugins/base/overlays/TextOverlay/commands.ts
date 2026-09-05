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

import { EditorContextValue, EditorCommand, Layer, Frame } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import type { TextLayerData } from '@opengpex/editor/core/types/models';
import * as P from './protocols';

// ─── Auto-grouping helpers ───────────────────────────────────────────────────
//
// Mirrors MarkerOverlay's auto-group logic (see docs shape_tool_spec §3.5.4):
// consecutively placed text layers are folded into a single auto-created group so
// the layers panel is not polluted by one-layer-per-text. Kept symmetric to, but
// deliberately separate from, the Marker implementation (distinct `isTextGroup`
// flag) so text and marker never share an auto-group.

/** A text layer produced by the Text Tool. */
function isTextLayer(l: Layer | undefined | null): boolean {
  return !!l && l.type === 'text';
}

/** A group auto-created by the Text Tool to hold consecutive text layers. */
function isTextGroup(l: Layer | undefined | null): boolean {
  return !!l && l.type === 'group' && l.metadata?.isTextGroup === true;
}

/**
 * Auto-grouping decision for a newly placed text layer, delegating the generic
 * "nearest same-kind neighbour" mechanism to LayerFactory and injecting only the
 * text-specific predicates. See LayerFactory.resolveNeighborGroupTarget for the
 * below-first / create / append / none semantics.
 */
function resolveGrouping(
  frame: Frame,
  below: Layer | null,
  above: Layer | null,
): { mode: 'none' } | { mode: 'append'; groupId: string } | { mode: 'create'; seedLayerId: string } {
  return LayerFactory.resolveNeighborGroupTarget(frame, below, above, {
    isMember: isTextLayer,
    isGroupHeader: isTextGroup,
  });
}

// ─── Commands ──────────────────────────────────────────────────────────────────

/**
 * cmd.place: Places a new text layer and enters editing state
 *
 * undoable: true → Automatically establish SIGNAL_COMMIT undo baseline before execution.
 * Undo will remove the newly created layer completely in one step.
 *
 * Auto-grouping: consecutively placed text layers are folded into an auto-created
 * `isTextGroup` group (see resolveGrouping). The group creation + seed groupId
 * backfill + new-layer insert all happen inside this single undoable command, so
 * one undo reverts cleanly and never leaves an empty group behind. This also
 * dovetails with the empty-text auto-delete path (useInlineTextEditing), which
 * undoes this whole command when a create session commits/cancels with no content.
 */
const placeCommand: EditorCommand<{ frameId: string; layer: Layer }, void> = {
  id: P.CMD_PLACE,
  name: 'Place Text Layer',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layer: Layer }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    if (!frame) return;

    // The new text always lands directly above the active layer. `insertAt` is the
    // single source of truth for its slot; grouping only decides `groupId` and
    // whether/where a group header is inserted — never the new layer's slot.
    const below = LayerFactory.resolveActiveHostLayer(frame);
    const insertAt = LayerFactory.getInsertIndexAbove(frame, below?.id);
    const above = LayerFactory.resolveHostAbove(frame, insertAt);
    const decision = resolveGrouping(frame, below, above);

    // 'append': join the group and land at the TOP of its member block via
    // getInsertIndexAbove(groupId). This is the group-contiguity guarantee — a
    // plain `insertAt` could wedge the new layer BELOW the group header when the
    // group was matched via the above neighbour, violating spec §2.2 (header at
    // the bottom of the member block).
    if (decision.mode === 'append') {
      const layer = { ...payload.layer, groupId: decision.groupId };
      const groupInsertAt = LayerFactory.getInsertIndexAbove(frame, decision.groupId);
      ctx.layers.addLayer(payload.frameId, layer, groupInsertAt);
      finishPlace(ctx, payload.frameId, layer.id);
      return;
    }

    if (decision.mode === 'create') {
      const seedId = decision.seedLayerId;

      // Name the group after the existing host layers ("Group Texts", "Group Texts 2"…).
      const hostLayers = LayerFactory.getHostLayers(
        frame.layers.order.map(id => frame.layers.byId[id]),
      );
      const groupName = LayerFactory.getNewLayerName(hostLayers, 'Group Texts');
      const group = LayerFactory.getNewGroup({
        name: groupName,
        metadata: { isTextGroup: true },
      });

      // Move the existing bare text (the seed) into the group — only its groupId
      // changes; its z-order slot is untouched.
      ctx.actions.updateLayer(payload.frameId, seedId, { groupId: group.id });

      // Header goes to the BOTTOM of the combined {seed, new-text} member block
      // (layer group spec §2.2). The block's lowest slot is min(seedIdx, insertAt):
      //   • seed BELOW the slot (active is the seed) → seedIdx < insertAt → seedIdx
      //   • seed ABOVE the slot (grouped via the above neighbour) → seedIdx === insertAt
      // In create mode `insertAt` is always defined (either neighbour that seeded
      // the group implies a defined slot).
      const seedIdx = frame.layers.order.indexOf(seedId);
      const headerIndex = Math.min(seedIdx, insertAt as number);
      ctx.layers.addLayer(payload.frameId, group, headerIndex);

      // Inserting the header at headerIndex (≤ insertAt) shifted the new-text slot
      // up by exactly one, so it lands at insertAt + 1 — directly above the seed
      // when the seed is below, or directly below the seed when the seed is above.
      const layer = { ...payload.layer, groupId: group.id };
      ctx.layers.addLayer(payload.frameId, layer, (insertAt as number) + 1);
      finishPlace(ctx, payload.frameId, layer.id);
      return;
    }

    // mode 'none': plain layer, inserted directly above the active layer
    // (getInsertIndexAbove handles group / hostId targets). Falls back to
    // append-on-top (undefined index → reducer push) when there is no active layer.
    ctx.layers.addLayer(payload.frameId, payload.layer, insertAt);
    finishPlace(ctx, payload.frameId, payload.layer.id);
  },
};

/**
 * finishPlace: shared tail of cmd.place — activate the new text layer and enter
 * the inline create-editing session. Kept identical across all grouping modes so
 * auto-grouping never changes the editing/undo-baseline behavior.
 */
function finishPlace(ctx: EditorContextValue, frameId: string, layerId: string): void {
  ctx.layers.activate(frameId, layerId);
  ctx.scoped!.setSignal(P.SIGNAL_EDITING_TEXT_LAYER_ID, layerId);
  ctx.scoped!.setSignal(P.SIGNAL_SESSION_TYPE, 'create');
}

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
