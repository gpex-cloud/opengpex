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

import { EditorCommand, EditorContextValue } from '@opengpex/editor/core/types';
import { VIEWPORT_FIT_PADDING } from '@opengpex/editor/core/helpers/presets';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * VIEWPORT_TRANSLATE_COMMANDS: Handles translation, scaling, and adaptive alignment of the viewport.
 */
export const ViewportTranslateCommands = {
  fit: {
    id: P.ADV_VIEWPORT_FIT,
    name: 'Fit Visible',
    execute: (ctx: EditorContextValue): void => {
      const { geometry, activeFrame, state, actions, volatileRef } = ctx;
      if (!activeFrame) return;

      actions.setInteraction({ isInteracting: false });
      Object.assign(volatileRef.current, { camera: null, isInteracting: false });

      const { w, h } = state.ui.viewportDim;
      const { insets } = state.ui.theme.config;

      const nextCamera = geometry.camera.getFitCamera(
        { w, h },
        activeFrame.canvas,
        {
          padding: VIEWPORT_FIT_PADDING,
          maxScale: 1,
          offsetTop: insets.top,
          offsetLeft: insets.fixed.left,
          offsetRight: insets.fixed.right,
          offsetBottom: insets.bottom
        }
      );

      actions.updateCamera(activeFrame.id, nextCamera);
    },
    // [Shortcut] Fit Visible: ⌘+1 / Ctrl+1
    shortcuts: [{ key: '1', meta: true }, { key: '1', ctrl: true }]
  } as EditorCommand<void, void>,

  actualSize: {
    id: P.ADV_VIEWPORT_ACTUAL,
    name: 'Actual Size',
    execute: (ctx: EditorContextValue): void => {
      const { geometry, activeFrame, state, actions, volatileRef } = ctx;
      if (!activeFrame) return;

      actions.setInteraction({ isInteracting: false });
      Object.assign(volatileRef.current, { camera: null, isInteracting: false });

      const { w, h } = state.ui.viewportDim;
      const { insets } = state.ui.theme.config;

      const nextCamera = geometry.camera.getFitCamera(
        { w, h },
        activeFrame.canvas,
        {
          fixedScale: 1,
          offsetTop: insets.top,
          offsetLeft: insets.fixed.left,
          offsetRight: insets.fixed.right,
          offsetBottom: insets.bottom
        }
      );

      actions.updateCamera(activeFrame.id, nextCamera);
    },
    // [Shortcut] Actual Size (1:1): ⌘+2 / Ctrl+2
    shortcuts: [{ key: '2', meta: true }, { key: '2', ctrl: true }]
  } as EditorCommand<void, void>,

  zoomBy: {
    id: P.ADV_VIEWPORT_ZOOM,
    name: 'Zoom By Ratio',
    execute: (ctx: EditorContextValue, k: number): void => {
      const { activeFrame, state, actions, volatileRef } = ctx;
      if (!activeFrame) return;

      const v = volatileRef.current;
      const currentCam = (v.activeState.interacting && v.buffered.frames[activeFrame.id]?.camera)
        ? v.buffered.frames[activeFrame.id]!.camera!
        : activeFrame.camera;

      actions.mutateVolatile(v => {
        v.activeState.interacting = false;
        v.buffered.frames[activeFrame.id] = { ...v.buffered.frames[activeFrame.id], camera: undefined };
      });

      const { x, y, k: oldK } = currentCam;
      const { w: vw, h: vh } = state.ui.viewportDim;
      const { insets } = state.ui.theme.config;

      const boundedK = Math.max(0.01, Math.min(10, k));

      const centerX = (vw + insets.fixed.left - insets.fixed.right) / 2;
      const centerY = (vh + insets.top - insets.bottom) / 2;

      const nextX = centerX - (centerX - x) * (boundedK / oldK);
      const nextY = centerY - (centerY - y) * (boundedK / oldK);

      actions.updateCamera(activeFrame.id, { x: nextX, y: nextY, k: boundedK });
    }
  } as EditorCommand<number, void>
};
