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

import { InteractionHandler } from '@opengpex/editor/core/types';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { ROTATE_CURSOR } from '@opengpex/editor/icons';
import { ACTIVE_CRAFT_KEY, resolveGizmoTargetLayer } from './shared';

// ─── TextRotateHandler ──────────────────────────────────────────────────────────

/**
 * TextRotateHandler: drag the rotation handle to freely rotate the text layer.
 *
 * Priority 165 (> TextResizeHandler 160 > TextPlaceHandler 150): a pointerdown
 * on the rotate handle must win over resize / place. Gated to text craft
 * pre-edit state; the handle is a DOM dot rendered by LayerOverlay's text
 * gizmo carrying `data-gizmo-rotate`.
 *
 * Math: identical to MarkerRotateHandler — atan2 delta → rotation.
 * Shift → snap to nearest 15°.
 *
 * Non-silent: the rotation lands as its own undoable history step.
 */
export const createTextRotateHandler = (): InteractionHandler => {
  let rotateLayerId: string | null = null;
  let startAngleRad = 0;
  let startRotation = 0;
  let layerCx = 0;
  let layerCy = 0;
  let tx: InteractionTransaction | null = null;

  return {
    id: 'text-rotate',
    priority: 165,

    test: (e) => {
      if (e.state.interaction.interactionMode !== 'craft') return false;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'text') return false;

      const target = e.nativeEvent.target as HTMLElement;
      if (!target.closest('[data-text-gizmo] [data-gizmo-rotate]')) return false;

      const layer = resolveGizmoTargetLayer(e);
      if (!layer) return false;

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

      // Non-silent: own undoable history step (see TextMoveHandler).
      tx = new InteractionTransaction(e);
      tx.begin();
      // Declare the gesture feedback for the system-level delta label (the
      // widget shows the target's live absolute angle). Cleared by the
      // transaction's commit/abort.
      tx.declareFeedback({ kind: 'rotate', target: 'layer', targetId: rotateLayerId, origin: { x: layerCx, y: layerCy } });
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
