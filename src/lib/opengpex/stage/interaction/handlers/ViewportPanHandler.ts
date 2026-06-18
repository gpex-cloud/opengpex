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

import { InteractionHandler, CameraState } from '@opengpex/editor/core/types';
import { InteractionTransaction } from '../Transaction';

/**
 * ViewportPanHandler: Handles canvas panning (Pan)
 * Supports: right-click drag, pan mode left-click drag, and mouse drag outside canvas in any mode
 */
export const createViewportPanHandler = (): InteractionHandler => {
  let lastMouse = { x: 0, y: 0 };
  let currentCam: CameraState | null = null;
  let tx: InteractionTransaction | null = null;

  return {
    id: 'viewport-pan',
    priority: 0, // Lowest priority for basic pan
    test: (e) => {
      const mouseEvent = e.nativeEvent as MouseEvent;
      const isRightClick = mouseEvent.button === 2;
      const isPanMode = e.state.interaction.interactionMode === 'pan';

      // In any mode, mouse down outside canvas triggers canvas panning
      const frame = e.activeFrame;
      const isOutsideCanvas = !e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h
      });

      // If right-click, or pan mode is active, or mouse is outside canvas
      return isRightClick || isPanMode || isOutsideCanvas;
    },
    onStart: (e) => {
      lastMouse = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
      // Core optimization: capture base camera once at interaction start, establishing local closure tracking
      currentCam = e.actions.fast.latestCamera(e.activeFrame.id);
      
      tx = new InteractionTransaction(e);
      // Panning is not undoable, so we pass silent=true
      tx.begin(true);
    },
    onMove: (e) => {
      if (!currentCam || !tx) return;

      const dx = e.nativeEvent.clientX - lastMouse.x;
      const dy = e.nativeEvent.clientY - lastMouse.y;
      
      // Incrementally evolve based on local state, avoiding latestCamera lookups each frame
      currentCam = e.geometry.camera.projectPan(currentCam, { x: dx, y: dy });
      
      tx.update({ camera: currentCam }, 'frame');
      
      lastMouse = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
    },
    onEnd: () => {
      if (tx) {
        tx.commit();
        tx = null;
      }
      currentCam = null;
    }
  };
};
