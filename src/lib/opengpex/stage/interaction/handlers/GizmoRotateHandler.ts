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
 * createGizmoRotateHandler: THE shared layer-channel rotate gesture — drag a
 * TransformGizmo rotation handle (`data-gizmo-rotate`) to freely rotate a
 * layer about its centre.
 *
 * History (20261122): text / marker / pen each hand-rolled a byte-identical
 * rotate handler (~110 lines: craft-mode gate, DOM scope match, atan2 delta,
 * Shift 15° snap, layer-channel write, delta-chip feedback). The only real
 * variation between them was WHICH layer the gesture drives and which gizmo
 * scope the handle lives in — everything else was copy-paste. This handler is
 * the convergence: the gesture skeleton lives here ONCE, and each tool
 * declares its scope + target admission through config. Selection-domain
 * rotation (plain selection polygon / peel fragment) intentionally stays out:
 * those drive a confinement polygon / fragment pose, not `layer.rotation`,
 * and are embedded in the scale/rotate composite handlers' shared state
 * machine (see the refactor delegation doc §四 Phase 2).
 *
 * Math (identical to the retired per-tool copies):
 *   startAngle = atan2(pointer.world − layer centre)
 *   onMove:    newRotation = startRotation + (currentAngle − startAngle)
 *   Shift    → snap the ABSOLUTE angle to the nearest 15° step
 *              (normalizeAngle keeps the record in [0, 360)).
 *
 * The write rides the LAYER channel only (`layer.rotation`; penData /
 * markerData are untouched — every payload consumer resolves coordinates
 * through the layer matrix, the text/marker precedent pen documents).
 *
 * Non-silent: the rotation lands as its own undoable history step. Tools
 * whose layers composite incrementally declare `useIncreComp` in config
 * (marker/pen precedent); the default plain transaction fits text.
 */

import type { InteractionEvent, InteractionHandler, Layer } from '@opengpex/editor/core/types';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { ROTATE_CURSOR } from '@opengpex/editor/icons';

export interface GizmoRotateHandlerConfig {
  /** Handler id inside the interaction pipeline. */
  id: string;
  /** Pipeline priority: must exceed the tool's resize/move handlers. */
  priority: number;
  /**
   * CSS selector matching the tool's gizmo rotation handle — the descendant
   * `data-gizmo-rotate` dot scoped under the tool's gizmo container, e.g.
   * `[data-text-gizmo] [data-gizmo-rotate]`. The shared `test` fires only
   * when the pressed target matches.
   */
  scopeSelector: string;
  /**
   * Tool-side admission: the craft/tool gating (interaction mode, active
   * craft key, payload kind checks) PLUS resolution of the target layer.
   * Returning null declines the gesture. Kept tool-side because the gating
   * keys (which craft signal, which payload field) are pure domain knowledge
   * the stage must not import.
   */
  admit: (e: InteractionEvent) => Layer | null;
  /**
   * Declare the gesture as an incremental-compositing writer (marker/pen
   * precedent — layers whose composite benefits from the incre-comp channel).
   * Absent = plain transaction (text).
   */
  useIncreComp?: boolean;
}

/** Shift snaps the ABSOLUTE rotation to 15° steps (industry standard). */
const SHIFT_SNAP_STEP_DEG = 15;

export function createGizmoRotateHandler(config: GizmoRotateHandlerConfig): InteractionHandler {
  let layerId: string | null = null;
  let startAngleRad = 0; // atan2 at gesture start
  let startRotation = 0; // layer.rotation at gesture start
  let centerWx = 0; // layer centre at gesture start (the rotation origin)
  let centerWy = 0;
  let tx: InteractionTransaction | null = null;

  return {
    id: config.id,
    priority: config.priority,

    test: (e) => {
      const target = e.nativeEvent.target as HTMLElement;
      if (!target.closest(config.scopeSelector)) return false;

      const layer = config.admit(e);
      if (!layer) return false;

      layerId = layer.id;
      return true;
    },

    onStart: (e) => {
      if (!layerId) return;
      const layer = e.activeFrame.layers.byId[layerId];
      if (!layer) return;

      centerWx = layer.cx;
      centerWy = layer.cy;
      startRotation = layer.rotation;
      startAngleRad = Math.atan2(e.point.world.y - centerWy, e.point.world.x - centerWx);

      // Non-silent: own undoable history step (see LayerMoveHandler).
      tx = new InteractionTransaction(e, config.useIncreComp ? { useIncreComp: true } : undefined);
      tx.begin(false);
      // Gesture feedback for the system-level delta chip: the readout is the
      // layer's live absolute angle, resolved from the merged frame via
      // targetId. Cleared by the transaction's commit/abort.
      tx.declareFeedback({
        kind: 'rotate',
        target: 'layer',
        targetId: layerId,
        origin: { x: centerWx, y: centerWy },
      });
      e.actions.fast.cursor.notifyDragging(ROTATE_CURSOR);
    },

    onMove: (e) => {
      if (!layerId || !tx) return;

      const currentAngleRad = Math.atan2(e.point.world.y - centerWy, e.point.world.x - centerWx);
      const deltaDeg = ((currentAngleRad - startAngleRad) * 180) / Math.PI;
      let newRotation = e.geometry.transform.normalizeAngle(startRotation + deltaDeg);

      if ((e.nativeEvent as MouseEvent).shiftKey) {
        newRotation = e.geometry.transform.normalizeAngle(
          e.geometry.transform.snapAngle(startRotation + deltaDeg, SHIFT_SNAP_STEP_DEG),
        );
      }

      tx.update({ rotation: newRotation }, 'layer', layerId);
    },

    onEnd: (e) => {
      if (tx) {
        tx.commit();
        tx = null;
      }
      layerId = null;
      e.actions.fast.cursor.notifyDragging(null);
      e.actions.fast.cursor.notifyHover(null);
    },

    onCancel: (e) => {
      if (tx) {
        tx.abort();
        tx = null;
      }
      layerId = null;
      e.actions.fast.cursor.notifyDragging(null);
    },
  };
}
