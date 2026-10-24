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
 * PenMoveHandler (priority 162) — drag inside a pen layer's visible shape to
 * move the WHOLE layer (cx/cy only — penData is layer-local and untouched by
 * translation). MarkerMoveHandler parity: no modifier needed.
 *
 * Press arbitration against the editing surface:
 * - ON the path geometry (anchor or curve hit): pen-edit keeps the press —
 *   an anchor drag or a segment split must never degrade into a layer move.
 *   The one exception is Cmd/Ctrl (the Illustrator temporary-selection
 *   grammar), which claims geometry hits for the move.
 * - OFF the geometry but inside the layer's visible shape (factory-seeded to
 *   the full bounding, tracked by pen-resize): THIS handler moves the layer —
 *   the same visibleShape pick `testLayerHit` gives the marker move.
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
    priority: 162,

    test: (e) => {
      if (!passesBaseGate(e)) return false;
      // During a drawing session every click belongs to pen-draw.
      if (getPenDraft(e.actions.scratch, e.activeFrame.id) !== null) return false;

      const geometryLayerId = findCommittedPenLayerAt(e.geometry, e.activeFrame, e.point.canvas, cameraZoom(e));
      if (e.keys.meta) {
        // Cmd/Ctrl: full-move modifier — a geometry hit moves the layer
        // instead of editing the anchor / splitting the segment.
        targetLayerId = geometryLayerId ?? findPenLayerBoxAt(e.geometry, e.activeFrame, e.point.canvas);
        return targetLayerId !== null;
      }
      // Plain press: on-geometry stays with pen-edit; off-geometry inside the
      // visible shape moves the layer (marker parity, no modifier).
      if (geometryLayerId) return false;
      targetLayerId = findPenLayerBoxAt(e.geometry, e.activeFrame, e.point.canvas);
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
      e.actions.fast.setCursor('grabbing');
    },

    onMove: (e) => {
      if (!targetLayerId || !tx) return;
      const dx = e.point.canvas.x - startCanvas.x;
      const dy = e.point.canvas.y - startCanvas.y;
      tx.update({ cx: startLayerPos.x + dx, cy: startLayerPos.y + dy }, 'layer', targetLayerId);
    },

    onEnd: (e) => {
      if (tx) {
        tx.commit();
        tx = null;
      }
      targetLayerId = null;
      // Pointer is still inside the shape just dragged — hand the hover
      // cursor back directly (same convention as MarkerMoveHandler).
      e.actions.fast.setCursor('move');
    },

    onCancel: () => {
      if (tx) {
        tx.abort();
        tx = null;
      }
      targetLayerId = null;
    },
  };
};
