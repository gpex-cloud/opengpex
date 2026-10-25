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
 * PenRotateHandler (priority 166) — drag the gizmo rotation handle to freely
 * rotate the active pen layer. The handle is a DOM dot rendered by PenGizmo's
 * TransformGizmo carrying `data-gizmo-rotate`.
 *
 * Rotation rides the LAYER channel only — `layer.rotation` is written and
 * penData is untouched: every penData consumer (face renderer, pen-edit hit
 * tests, PenGizmo sync, the SVG overlay) already resolves coordinates through
 * the layer matrix, so the payload needs no rewrite (text/marker precedent).
 *
 * Math:
 *   startAngle = atan2(pointer.world − layer center)
 *   onMove: delta = currentAngle − startAngle → newRotation = startRotation + delta
 *   Shift → snap to nearest 15° (industry standard: 0/15/30/45/60/75/90…)
 *
 * Non-silent → a single undoable checkpoint per rotate gesture.
 */

import type { InteractionHandler } from '@opengpex/editor/core/types';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { ROTATE_CURSOR } from '@opengpex/editor/icons';
import { ACTIVE_CRAFT_KEY } from './shared';

export const createPenRotateHandler = (): InteractionHandler => {
  let rotateLayerId: string | null = null;
  let startAngleRad = 0;  // atan2 at gesture start
  let startRotation = 0;  // layer.rotation at gesture start
  let tx: InteractionTransaction | null = null;
  let layerCx = 0;
  let layerCy = 0;

  return {
    id: 'pen-rotate',
    priority: 166,

    test: (e) => {
      if (e.state.interaction.interactionMode !== 'craft') return false;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'pen') return false;

      const target = e.nativeEvent.target as HTMLElement;
      const rotateEl = target.closest('[data-gizmo-rotate]') as HTMLElement | null;
      if (!rotateEl) return false;

      // Bind to the currently active pen layer.
      const frame = e.activeFrame;
      const activeId = frame.activeLayerId;
      const layer = activeId ? frame.layers.byId[activeId] : null;
      if (!layer || layer.type !== 'vector' || !layer.penData) return false;

      rotateLayerId = layer.id;
      return true;
    },

    onStart: (e) => {
      if (!rotateLayerId) return;
      const frame = e.activeFrame;
      const layer = frame.layers.byId[rotateLayerId];
      if (!layer) return;

      layerCx = layer.cx;
      layerCy = layer.cy;
      startRotation = layer.rotation;
      startAngleRad = Math.atan2(
        e.point.world.y - layerCy,
        e.point.world.x - layerCx,
      );

      tx = new InteractionTransaction(e, { useIncreComp: true });
      tx.begin(false);
      e.actions.fast.cursor.notifyDragging(ROTATE_CURSOR);
    },

    onMove: (e) => {
      if (!rotateLayerId || !tx) return;

      const currentAngleRad = Math.atan2(
        e.point.world.y - layerCy,
        e.point.world.x - layerCx,
      );

      const deltaDeg = ((currentAngleRad - startAngleRad) * 180) / Math.PI;
      let newRotation = e.geometry.transform.normalizeAngle(startRotation + deltaDeg);

      // Shift → snap to nearest 15°.
      if ((e.nativeEvent as MouseEvent).shiftKey) {
        newRotation = e.geometry.transform.normalizeAngle(
          e.geometry.transform.snapAngle(startRotation + deltaDeg, 15),
        );
      }

      tx.update({ rotation: newRotation }, 'layer', rotateLayerId);
    },

    onEnd: (e) => {
      if (tx) {
        tx.commit();
        tx = null;
      }
      rotateLayerId = null;
      e.actions.fast.cursor.notifyDragging(null);
      e.actions.fast.cursor.notifyHover(null);
    },

    onCancel: (e) => {
      if (tx) {
        tx.abort();
        tx = null;
      }
      rotateLayerId = null;
      e.actions.fast.cursor.notifyDragging(null);
    },
  };
};
