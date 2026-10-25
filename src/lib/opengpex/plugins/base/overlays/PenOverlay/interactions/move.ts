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

/**
 * PenMoveHandler (priority 162) — Cmd/Ctrl + drag to move the WHOLE pen
 * layer (cx/cy only — penData is layer-local and untouched by translation).
 * Spring key ONLY: a bare press over a pen layer belongs to the pen gestures
 * (anchor editing on geometry, anchor placement while drawing).
 *
 * Press arbitration against the editing surface:
 * - ON the path geometry (anchor or curve hit): pen-edit keeps a bare press —
 *   an anchor drag or a segment split must never degrade into a layer move.
 *   The spring key claims geometry hits for the move (the Illustrator
 *   temporary-selection grammar).
 * - OFF the geometry but inside the layer's visible shape (factory-seeded to
 *   the full bounding, tracked by pen-resize): THIS handler moves the layer
 *   under the spring key — the same visibleShape pick `testLayerHit` gives
 *   the marker move.
 * - Outside every pen layer's visible shape: pen-draw places a new anchor.
 *
 * Fragment-triplet sub-layers (frag/exchange) never hit (host-only filter in
 * the shared pick), and during a draft session the whole layer-transform
 * surface yields (test requires the slot draft to be null — every click
 * belongs to pen-draw while a session is alive).
 */

import type { InteractionHandler } from '@opengpex/editor/core/types';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import {
  cameraZoom,
  findCommittedPenLayerAt,
  findPenLayerBoxAt,
  getPenDraft,
  passesBaseGate,
} from './shared';

export const createPenMoveHandler = (): InteractionHandler => {
  let startCanvas = { x: 0, y: 0 };
  let startLayerPos = { x: 0, y: 0 };
  let targetLayerId: string | null = null;
  let tx: InteractionTransaction | null = null;

  return {
    id: 'pen-move',
    // Cmd+drag = move this pen draft/layer — more precise than the global top-layer fallback.
    springOverride: 'meta',

    priority: 162,

    test: (e) => {
      if (!passesBaseGate(e)) return false;
      // During a drawing session every click belongs to pen-draw.
      if (getPenDraft(e.actions.scratch, e.activeFrame.id) !== null) return false;

      // Spring key ONLY: a bare press over a pen layer belongs to the pen
      // gestures (anchor edit on geometry, anchor placement while drawing) —
      // moving a committed layer is never a bare-press affordance.
      if (!e.spring.meta) return false;
      const geometryLayerId = findCommittedPenLayerAt(e.geometry, e.activeFrame, e.point.canvas, cameraZoom(e));
      // A geometry hit moves the layer instead of editing the anchor /
      // splitting the segment; a box hit (off-geometry, inside the visible
      // shape) moves too.
      targetLayerId = geometryLayerId ?? findPenLayerBoxAt(e.geometry, e.activeFrame, e.point.canvas);
      return targetLayerId !== null;
    },

    onStart: (e) => {
      if (!targetLayerId) return;
      const frame = e.activeFrame;
      const layer = frame.layers.byId[targetLayerId];
      if (!layer) return;

      // Moving a layer selects it: the gizmo (and any follow-up resize or
      // rotate) should land on what was just dragged.
      e.actions.setActiveLayer(frame.id, targetLayerId);

      startCanvas = { x: e.point.canvas.x, y: e.point.canvas.y };
      startLayerPos = { x: layer.cx, y: layer.cy };

      tx = new InteractionTransaction(e, { useIncreComp: true });
      tx.begin(false);
      e.actions.fast.cursor.notifyDragging('grabbing');
    },

    onMove: (e) => {
      if (!targetLayerId || !tx) return;
      const dx = e.point.canvas.x - startCanvas.x;
      const dy = e.point.canvas.y - startCanvas.y;
      tx.update({ cx: startLayerPos.x + dx, cy: startLayerPos.y + dy }, 'layer', targetLayerId);
    },

    onEnd: () => {
      if (tx) {
        tx.commit();
        tx = null;
      }
      targetLayerId = null;
      // No hover restoration: moving requires the spring key, so a
      // still-held Cmd keeps 'move' via the spring input; a released one
      // falls back to the tool cursor like any off-geometry hover.
    },

    onCancel: (e) => {
      if (tx) {
        tx.abort();
        tx = null;
      }
      targetLayerId = null;
      // Release the gesture cursor; the hover rule reasserts on the next move.
      e.actions.fast.cursor.notifyDragging(null);
    },
  };
};
