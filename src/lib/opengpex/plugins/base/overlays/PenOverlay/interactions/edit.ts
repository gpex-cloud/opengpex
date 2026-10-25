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
 * PenEditHandler (priority 160) — edit anchors of COMMITTED pen paths.
 *
 * A press on an anchor/handle (or on a curve, which splits the segment there
 * via de Casteljau and drags the fresh anchor) drags it in layer-local
 * space; Alt breaks handle symmetry. Each move re-anchors the payload to the
 * commit's padded-bounds convention and re-derives bounding/visibleShape/cx/cy
 * so the GPU crop and the gizmo track the edited geometry. The selection
 * PERSISTS after the gesture so Delete has a target; the next edit gesture
 * replaces it and a new drawing session clears it. During a draft session the
 * handler yields entirely — every click belongs to pen-draw.
 */

import type { InteractionHandler } from '@opengpex/editor/core/types';
import { asLocalShape } from '@opengpex/editor/core/types';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import type { PenSelection } from '../pen/penState';
import { dragCommittedAnchor, insertAnchorOnSegment } from '../pen/penState';
import { makeLayerPointMapping } from '../pen/geometry';
import { penBoundsPad, rebasePenDataToBounds } from '../pen/transform';
import {
  findAnchorHit,
  findSegmentHit,
  getPenDraft,
  passesBaseGate,
  setPenCommittedSelection,
} from './shared';

export const createPenEditHandler = (): InteractionHandler => {
  let tx: InteractionTransaction | null = null;
  let target: PenSelection | null = null;
  let segHit: { layerId: string; pathIdx: number; segIdx: number; t: number } | null = null;

  return {
    id: 'pen-edit',
    priority: 160,

    test: (e) => {
      if (!passesBaseGate(e)) return false;
      // During a drawing session every click belongs to pen-draw.
      if (getPenDraft(e.actions.scratch, e.activeFrame.id) !== null) return false;
      return findAnchorHit(e, e.point.canvas) !== null || findSegmentHit(e, e.point.canvas) !== null;
    },

    onStart: (e) => {
      const anchorHit = findAnchorHit(e, e.point.canvas);
      const layerId = anchorHit?.layerId ?? findSegmentHit(e, e.point.canvas)?.layerId;
      if (!layerId) return;

      let sel: PenSelection;
      segHit = null;
      if (anchorHit) {
        sel = anchorHit;
      } else {
        // Click on a curve: split the segment there and drag the fresh anchor.
        const segHitLocal = findSegmentHit(e, e.point.canvas)!;
        segHit = segHitLocal;
        sel = { layerId: segHitLocal.layerId, pathIdx: segHitLocal.pathIdx, anchorIdx: 0, kind: 'anchor' };
      }

      target = sel;
      setPenCommittedSelection(sel);
      // Open the transaction BEFORE the split write so the insertion is part
      // of the same undoable gesture as the subsequent drag.
      tx = new InteractionTransaction(e, { useIncreComp: true });
      tx.begin(false);
      if (!anchorHit) {
        const layer = e.activeFrame.layers.byId[sel.layerId];
        const inserted = insertAnchorOnSegment(layer.penData!, sel.pathIdx, segHit!.segIdx, segHit!.t);
        if (inserted) tx.update({ penData: inserted.path }, 'layer', sel.layerId);
      }
      e.actions.fast.cursor.notifyDragging('grabbing');
    },

    onMove: (e) => {
      if (!target || !tx) return;
      const frame = e.activeFrame;
      const layer = frame.layers.byId[target.layerId];
      if (!layer?.penData) return;
      const mapping = makeLayerPointMapping(e.geometry.transform.getLayerLocalMatrix(layer, frame));
      const localPt = mapping.toLayer(e.point.canvas);
      const next = dragCommittedAnchor(layer.penData, target, localPt, e.keys.alt);

      // Track the layer's bounds to the edited geometry: the commit convention
      // pads the flattened extents by half the stroke (+AA headroom) and keeps
      // the origin at the INFLATED bounds' top-left, and the scene assembler
      // crops the GPU render by visibleShape — an anchor dragged past the old
      // extents would be clipped and the gizmo box would lag behind. When the
      // extents moved, re-anchor the payload and re-derive the world centre so
      // every path point stays exactly where the pointer put it. The layer's
      // rotation/flip ride the world matrix's linear part (scale is 1.0).
      const rebase = rebasePenDataToBounds(next, penBoundsPad(layer.penStyle), e.geometry.bezier);
      if (rebase) {
        const M = e.geometry.transform.getLayerWorldMatrix(layer);
        const growX = (rebase.bounding.w - layer.bounding.w) / 2;
        const growY = (rebase.bounding.h - layer.bounding.h) / 2;
        const dx = rebase.shift.x + growX;
        const dy = rebase.shift.y + growY;
        tx.update({
          penData: rebase.penData,
          bounding: rebase.bounding,
          visibleShape: asLocalShape({ x: 0, y: 0, w: rebase.bounding.w, h: rebase.bounding.h }),
          cx: layer.cx + M.a * dx + M.c * dy,
          cy: layer.cy + M.b * dx + M.d * dy,
        }, 'layer', target.layerId);
      } else {
        tx.update({ penData: next }, 'layer', target.layerId);
      }
    },

    onEnd: (e) => {
      if (tx) {
        tx.commit();
        tx = null;
      }
      // The selection PERSISTS after the gesture so Delete has a target; the
      // next edit gesture replaces it and a new drawing session clears it.
      target = null;
      segHit = null;
      // Pointer is still over the anchor just dragged — hand the hover cursor
      // back directly (same convention as MarkerMoveHandler).
      e.actions.fast.cursor.notifyDragging(null);
      e.actions.fast.cursor.notifyHover('move');
    },

    onCancel: (e) => {
      if (tx) {
        tx.abort();
        tx = null;
      }
      setPenCommittedSelection(null);
      target = null;
      segHit = null;
      // Release the gesture cursor; the hover rule reasserts on the next move.
      e.actions.fast.cursor.notifyDragging(null);
    },
  };
};
