/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the GNU General Public License.
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
import type { Frame } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';
import { setEffectInstanceEnabled } from '@opengpex/editor/core/layer/effects';

/** Locate the frame holding `layerId` (the payload's frameId is advisory). */
function findFrameOfLayer(ctx: EditorContextValue, layerId: string): Frame | undefined {
  const { state } = ctx;
  return state.frames.order.map((id) => state.frames.byId[id]).find((f) => !!f.layers.byId[layerId]);
}

/**
 * Layer render-effect chain management (A8): toggle one entry's `enabled`
 * flag. The single adv-level effect command — the toggle mutates DOCUMENT
 * state (the chain on the layer), exactly like the mask siblings above.
 * The floor rule deliberately does NOT apply to disable ("no effect" is
 * expressed as a disabled instance, never a missing one); enabling a
 * missing instance is a silent no-op (the caller creates instances through
 * the chain vocabulary instead).
 */
export const LayerEffectCommands = {
  toggleEffectInstance: {
    id: P.ADV_LAYER_EFFECT_TOGGLE,
    name: 'Toggle Effect Instance',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; instanceId: string; enabled: boolean }): void => {
      if (!payload?.layerId || !payload.instanceId) return;
      const frame = findFrameOfLayer(ctx, payload.layerId);
      const layer = frame?.layers.byId[payload.layerId];
      if (!frame || !layer) return;
      const patch = setEffectInstanceEnabled(layer, payload.instanceId, payload.enabled);
      if (patch) ctx.actions.updateLayer(frame.id, layer.id, patch);
    },
  } as EditorCommand<{ frameId?: string; layerId: string; instanceId: string; enabled: boolean }, void>,
};
