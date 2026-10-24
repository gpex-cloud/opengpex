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
 * PenDblClickActivateHandler — double-click a pen layer from OUTSIDE the pen
 * tool (pan mode) to enter the tool with that layer selected.
 *
 * MarkerDblClickActivateHandler parity (priority 175, pan mode only): in pan
 * mode the first press of the pair goes to the stage LayerMoveHandler
 * (priority 10, selects the layer), the second press is claimed here and
 * fully consumed (empty onMove/onEnd) so it can never degrade into a stray
 * drag. Inside the pen tool the handler stays out of the way (pan-mode gate):
 * a single click already moves the layer through pen-move, and there is no
 * deeper state a double-click could enter.
 */

import type { InteractionHandler } from '@opengpex/editor/core/types';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import { findPenLayerBoxAt } from './shared';

/** Max gap between two presses to count as a double-click (fallback path). */
const DBL_CLICK_INTERVAL_MS = 450;

/** Max pointer travel between the two presses (canvas px, fallback path). */
const DBL_CLICK_TRAVEL_PX = 5;

export const createPenDblClickActivateHandler = (): InteractionHandler => {
  let lastDownTime = 0;
  let lastDownX = 0;
  let lastDownY = 0;

  return {
    id: 'pen-dblclick-activate',
    priority: 175,

    test: (e) => {
      if (e.state.interaction.interactionMode !== 'pan') return false;

      const target = e.nativeEvent.target as HTMLElement | null;
      if (target?.closest('button, a, input, [data-role="ui"], [data-handle], [data-gizmo-handle], [data-gizmo-rotate]')) return false;

      const now = performance.now();
      const isDoubleClick =
        (e.nativeEvent as MouseEvent).detail === 2 ||
        (now - lastDownTime <= DBL_CLICK_INTERVAL_MS &&
          Math.hypot(e.point.canvas.x - lastDownX, e.point.canvas.y - lastDownY) <= DBL_CLICK_TRAVEL_PX);
      lastDownTime = now;
      lastDownX = e.point.canvas.x;
      lastDownY = e.point.canvas.y;

      if (!isDoubleClick) return false;
      // Activatable = a visible, unlocked HOST pen layer under the press
      // (the host-only + locked/visible filter lives in the shared pick).
      return findPenLayerBoxAt(e.geometry, e.activeFrame, e.point.canvas) !== null;
    },

    onStart: (e) => {
      const layerId = findPenLayerBoxAt(e.geometry, e.activeFrame, e.point.canvas);
      if (!layerId) return;
      // Pan-mode gate above guarantees the pen craft is not active, so the
      // toggle semantics of activateCraft cannot deactivate it here.
      e.actions.executeCommand(CraftDrawerAPI.commands.activatePen.uid);
      e.actions.setActiveLayer(e.activeFrame.id, layerId);
    },

    // Claimed gestures are fully consumed: the double-click must never fall
    // through to a layer drag.
    onMove: () => {},
    onEnd: () => {},
  };
};
