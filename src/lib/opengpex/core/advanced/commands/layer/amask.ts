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
import type { Frame } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';

/** Locate the frame holding `layerId` (the payload's frameId is advisory). */
function findFrameOfLayer(ctx: EditorContextValue, layerId: string): Frame | undefined {
  const { state } = ctx;
  return state.frames.order.map((id) => state.frames.byId[id]).find((f) => !!f.layers.byId[layerId]);
}

/**
 * Adjustment-mask (grade chain) management: toggle and remove one entry.
 * Entries are otherwise immutable from the panel — editing an older step
 * means deleting it and re-committing (the new step lands at the chain tail).
 */
export const LayerAdjustMaskCommands = {
  toggleAdjustMask: {
    id: P.ADV_LAYER_ADJUST_MASK_TOGGLE,
    name: 'Toggle Adjustment Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; maskId: string }): void => {
      if (!payload?.layerId || !payload.maskId) return;
      const frame = findFrameOfLayer(ctx, payload.layerId);
      const layer = frame?.layers.byId[payload.layerId];
      if (!frame || !layer?.adjustMasks) return;
      if (!layer.adjustMasks.some((m) => m.id === payload.maskId)) return;
      const next = layer.adjustMasks.map((m) =>
        m.id === payload.maskId ? { ...m, enabled: !m.enabled } : m,
      );
      ctx.actions.updateLayer(frame.id, layer.id, { adjustMasks: next });
    },
  } as EditorCommand<{ frameId?: string; layerId: string; maskId: string }, void>,

  removeAdjustMask: {
    id: P.ADV_LAYER_ADJUST_MASK_REMOVE,
    name: 'Remove Adjustment Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; maskId: string }): void => {
      if (!payload?.layerId || !payload.maskId) return;
      const frame = findFrameOfLayer(ctx, payload.layerId);
      const layer = frame?.layers.byId[payload.layerId];
      if (!frame || !layer?.adjustMasks) return;
      const next = layer.adjustMasks.filter((m) => m.id !== payload.maskId);
      if (next.length === layer.adjustMasks.length) return;
      ctx.actions.updateLayer(frame.id, layer.id, { adjustMasks: next.length ? next : undefined });
    },
  } as EditorCommand<{ frameId?: string; layerId: string; maskId: string }, void>,
};
