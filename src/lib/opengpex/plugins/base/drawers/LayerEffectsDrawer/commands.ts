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

/**
 * LayerEffectsDrawer commands (A8 P3).
 *
 * TWO WRITE CHANNELS, mirroring the AdjustmentDrawer's split:
 *
 *   • UNDOABLE STRUCTURAL — `applyEffectPatch` / `removeEffectInstance` /
 *     `toggleEffectInstance` land ONE Redux write per invocation (add,
 *     delete, eye toggle). Patches are produced by the pure chain vocabulary
 *     in `core/layer/effects.ts`, so every caller gets the floor rule ("a
 *     category never empties") for free.
 *
 *   • FAST GESTURE PAIR — `fastUpdateEffectParams` parks each pointermove on
 *     the volatile buffer (`actions.fast.overrideLayer`, folded into the
 *     rendered frame per ticker tick — live canvas, zero Redux/React
 *     traffic) and `commitEffectParams` lands ONE Redux write at gesture
 *     end. The undo step is owned by the `beginEffectEdit` checkpoint
 *     (undoable, empty body) fired at pointerdown — the same three-piece
 *     contract the adjustments sliders run on. The payload carries the FULL
 *     StrokeParams, computed by the panel against
 *     `actions.fast.latestLayer` (the FRESHEST draft: the gesture's draft
 *     replaces the chain wholesale, so a Redux baseline would resurrect last
 *     frame's values mid-gesture — exactly the adjustment fast path's
 *     rationale).
 */

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import type { Layer, StrokeParams } from '@opengpex/editor/core/types/models';
import {
  removeEffectInstance,
  updateEffectParams,
} from '@opengpex/editor/core/layer/effects';
import * as P from './protocols';

export const EFFECT_COMMANDS = {
  // ─── Gesture checkpoint (owns the undo step for one drag) ────────────────

  beginEffectEdit: {
    id: P.CMD_BEGIN_EFFECT_EDIT,
    name: 'Begin Effect Edit',
    undoable: true,
    execute: () => {},
  } as EditorCommand<void, void>,

  // ─── Fast gesture pair (volatile per-move, ONE commit at gesture end) ────

  fastUpdateEffectParams: {
    id: P.CMD_FAST_UPDATE_EFFECT,
    name: 'Fast-Track Effect Params',
    execute: (
      ctx: EditorContextValue,
      payload: { instanceId: string; params: StrokeParams },
    ) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      // Baseline on the FRESHEST draft, not Redux (see the module header).
      const latest = actions.fast.latestLayer(activeFrame.id, activeLayer.id) ?? activeLayer;
      const patch = updateEffectParams(latest, payload.instanceId, payload.params);
      if (patch) actions.fast.overrideLayer(activeFrame.id, activeLayer.id, patch);
    },
  } as EditorCommand<{ instanceId: string; params: StrokeParams }, void>,

  commitEffectParams: {
    id: P.CMD_COMMIT_EFFECT,
    name: 'Commit Effect Params',
    execute: (ctx: EditorContextValue) => {
      const { activeLayer, actions } = ctx;
      if (!activeLayer) return;
      actions.fast.commit(activeLayer.id);
    },
  } as EditorCommand<void, void>,

  // ─── Undoable structural writes (add / delete / eye) ─────────────────────

  applyEffectPatch: {
    id: P.CMD_APPLY_EFFECT_PATCH,
    name: 'Apply Effect Patch',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { patch: Partial<Layer> }) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      actions.updateLayer(activeFrame.id, activeLayer.id, payload.patch);
    },
  } as EditorCommand<{ patch: Partial<Layer> }, void>,

  removeEffectInstance: {
    id: P.CMD_REMOVE_EFFECT_INSTANCE,
    name: 'Remove Effect Instance',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { instanceId: string }) => {
      const { activeFrame, activeLayer, actions } = ctx;
      if (!activeFrame || !activeLayer) return;
      // The chain vocabulary refuses to empty a category (floor rule) — a
      // null patch is a no-op here, and the UI disables the control first.
      const patch = removeEffectInstance(activeLayer, payload.instanceId);
      if (patch) actions.updateLayer(activeFrame.id, activeLayer.id, patch);
    },
  } as EditorCommand<{ instanceId: string }, void>,

  // NOTE: there is deliberately NO plugin toggle command here — the chain
  // toggle is a DOCUMENT mutation and lives in the core adv namespace
  // (ADV_LAYER_EFFECT_TOGGLE → actions.adv.layer.effect.toggle), shared by
  // this drawer's rail eye and the layers-drawer family rows.

  // ─── P4 jump channel (the layers-drawer family row's ⤴ button) ───────────

  openEffectInstancePanel: {
    id: P.CMD_OPEN_EFFECT_INSTANCE_PANEL,
    name: 'Open Effect Instance Panel',
    execute: (ctx: EditorContextValue, payload: { instanceId: string }) => {
      // Two store ops: reveal the drawer in the sidebar (idempotent push),
      // then set the jump signal. The nonce (monotonic per jump) lets the
      // drawer's render-derived tab resolution distinguish a FRESH jump from
      // a stale signal and from the user's later manual tab clicks — no
      // effects, no set-state-in-effect.
      const pluginUid = `${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}`;
      const currentIds = ctx.state.ui.activeSidebarIds || [];
      if (!currentIds.includes(pluginUid)) {
        ctx.actions.updateUI({ activeSidebarIds: [...currentIds, pluginUid] });
      }
      ctx.actions.setStateSignal(P.EffectsDrawerAPI.signals.jump, {
        instanceId: payload.instanceId,
        nonce: Date.now(),
      });
    },
  } as EditorCommand<{ instanceId: string }, void>,
};

export default EFFECT_COMMANDS;
