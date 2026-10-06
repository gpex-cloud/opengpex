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

import { EditorContextValue, EditorCommand, BitmapMask, LocalRect } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * ONE record write inside an {@link LayerBitmapMaskCommands.applyBitmapMaskBatch}
 * payload. Every op carries APPLY semantics: it lands on the record `maskId`
 * points at, or creates that record when the id is absent (adopting it).
 * A record's family (`inverted`) is fixed at birth — the create route writes
 * it, the rewrite route never touches it.
 */
export interface BitmapMaskBatchOp {
  /** APPLY semantics — the membership lookup at execute time decides the route. */
  kind: 'apply';
  /**
   * Target record id. The session's transient id (`mask-*-erase` /
   * `mask-*-restore`) for a brand-new record is guaranteed absent from the
   * model until the bake adopts it, so "id present → rewrite in place, id
   * absent → create + adopt" is unambiguous.
   */
  maskId?: string;
  src: string;
  assetId: string;
  bounds: LocalRect;
  /** HARD mask edge; `false`/omitted clears a stale `hard: true` (patch spread). */
  hard?: boolean;
  /** Family (erase family when omitted); only written when the op creates the record. */
  inverted?: boolean;
  /** Marks the record as having received stamps (see `BitmapMask.painted`). */
  painted?: boolean;
}

/**
 * BITMAP_MASK_COMMANDS: Bitmap mask management command set.
 * Contains: adding, updating, batch-applying (single undoable unit), toggling,
 * removing, and clearing bitmap masks.
 */
export const LayerBitmapMaskCommands = {
  addBitmapMask: {
    id: P.ADV_LAYER_BITMAP_MASK_ADD,
    name: 'Add Bitmap Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; src: string; assetId: string; bounds: LocalRect; hard?: boolean; inverted?: boolean; painted?: boolean }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId || !payload.src || !payload.assetId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer) return;

      const newMask = LayerFactory.getNewBitmapMask(payload.src, payload.assetId, payload.bounds, payload.hard, payload.inverted);
      if (payload.painted) newMask.painted = true;
      actions.updateLayer(frame.id, payload.layerId, {
        bitmapMasks: [...(layer.bitmapMasks || []), newMask]
      });
    }
  } as EditorCommand<{ frameId?: string; layerId: string; src: string; assetId: string; bounds: LocalRect; hard?: boolean; inverted?: boolean; painted?: boolean }, void>,

  updateBitmapMask: {
    id: P.ADV_LAYER_BITMAP_MASK_UPDATE,
    name: 'Update Bitmap Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; maskId: string; patch: Partial<BitmapMask> }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId || !payload.maskId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer || !layer.bitmapMasks) return;

      const nextMasks = layer.bitmapMasks.map(m =>
        m.id === payload.maskId ? { ...m, ...payload.patch } : m
      );
      actions.updateLayer(frame.id, payload.layerId, { bitmapMasks: nextMasks });
    }
  } as EditorCommand<{ frameId?: string; layerId: string; maskId: string; patch: Partial<BitmapMask> }, void>,

  /**
   * applyBitmapMaskBatch: Applies MULTIPLE mask add/update operations to ONE
   * layer as a SINGLE undoable command.
   *
   * The restore architecture's erase op touches several records at once (the
   * erase-family record update + a white hole-fill into every painted
   * restore-family record). Those writes are one logical edit — committing
   * them as separate undoable commands would let undo/redo tear apart the
   * "erase and hole-fill move together" invariant. Executing them inside ONE
   * command keeps the pre-execution SIGNAL_COMMIT (the undo snapshot) shared
   * by all writes, so undo/redo steps the whole stroke as one unit.
   */
  applyBitmapMaskBatch: {
    id: P.ADV_LAYER_BITMAP_MASK_APPLY_BATCH,
    name: 'Apply Bitmap Mask Batch',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; ops: BitmapMaskBatchOp[] }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId || !payload.ops || payload.ops.length === 0) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer) return;

      let nextMasks = [...(layer.bitmapMasks || [])];
      for (const op of payload.ops) {
        if (!op.src || !op.assetId) continue;

        // APPLY route: one membership lookup decides everything. A transient
        // session id is guaranteed absent until adopted (suffix + mint-time),
        // so "present → rewrite, absent → create + adopt" carries no ambiguity.
        const existing = op.maskId ? nextMasks.find(m => m.id === op.maskId) : undefined;

        if (existing) {
          // Rewrite in place. `inverted` is deliberately absent from the patch
          // — a record's family is fixed at birth.
          nextMasks = nextMasks.map(m =>
            m.id === existing.id
              ? {
                  ...m,
                  src: op.src,
                  assetId: op.assetId,
                  bounds: op.bounds,
                  ...(op.hard ? { hard: true } : { hard: undefined }),
                  ...(op.painted ? { painted: true } : {}),
                }
              : m
          );
        } else {
          // Create + ADOPT the caller's id: the bake passes the session's
          // transient id so the engine's resident live-preview texture is
          // re-keyed by the bake instead of orphaned. Reaching this branch
          // already proves the id is free (the lookup above came up empty).
          const newMask = LayerFactory.getNewBitmapMask(op.src, op.assetId, op.bounds, op.hard, op.inverted);
          if (op.painted) newMask.painted = true;
          if (op.maskId) newMask.id = op.maskId;
          nextMasks.push(newMask);
        }
      }

      actions.updateLayer(frame.id, payload.layerId, { bitmapMasks: nextMasks });
    }
  } as EditorCommand<{ frameId?: string; layerId: string; ops: BitmapMaskBatchOp[] }, void>,

  toggleBitmapMask: {
    id: P.ADV_LAYER_BITMAP_MASK_TOGGLE,
    name: 'Toggle Bitmap Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; maskId: string }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId || !payload.maskId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer || !layer.bitmapMasks) return;

      const nextMasks = layer.bitmapMasks.map(m =>
        m.id === payload.maskId ? { ...m, enabled: !m.enabled } : m
      );
      actions.updateLayer(frame.id, payload.layerId, { bitmapMasks: nextMasks });
    }
  } as EditorCommand<{ frameId?: string; layerId: string; maskId: string }, void>,

  removeBitmapMask: {
    id: P.ADV_LAYER_BITMAP_MASK_REMOVE,
    name: 'Remove Bitmap Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string; maskId: string }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId || !payload.maskId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer || !layer.bitmapMasks) return;

      const nextMasks = layer.bitmapMasks.filter(m => m.id !== payload.maskId);
      actions.updateLayer(frame.id, payload.layerId, { bitmapMasks: nextMasks });
    }
  } as EditorCommand<{ frameId?: string; layerId: string; maskId: string }, void>,

  clearBitmapMasks: {
    id: P.ADV_LAYER_BITMAP_MASK_CLEAR,
    name: 'Clear All Bitmap Masks',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId?: string; layerId: string }): void => {
      const { state, actions } = ctx;
      if (!payload || !payload.layerId) return;

      const frame = state.frames.order.map(id => state.frames.byId[id]).find(f => !!f.layers.byId[payload.layerId]);
      if (!frame) return;

      const layer = frame.layers.byId[payload.layerId];
      if (!layer) return;

      actions.updateLayer(frame.id, payload.layerId, { bitmapMasks: [] });
    }
  } as EditorCommand<{ frameId?: string; layerId: string }, void>,
};
