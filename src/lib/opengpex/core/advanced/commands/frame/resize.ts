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

import { asLocalShape, EditorContextValue, EditorCommand, Layer } from '@opengpex/editor/core/types';
import { VIEWPORT_FIT_PADDING } from '@opengpex/editor/core/helpers/presets';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * FRAME_RESIZE_COMMANDS: Handles canvas resizing and physical resampling.
 */
export const FrameResizeCommands = {
  resizeCanvas: {
    id: P.ADV_FRAME_RESIZE_CANVAS,
    name: 'Resize Canvas',
    undoable: true,
    execute: (ctx: EditorContextValue): void => {
      const { geometry, activeFrame, actions, state } = ctx;
      if (!activeFrame) return;

      const { canvasCropBox: cropShape, canvas: oldCanvas, layers } = activeFrame;
      const cropBox = cropShape.rect;

      const shiftX = (cropBox.x + cropBox.w / 2) - oldCanvas.w / 2;
      const shiftY = (cropBox.y + cropBox.h / 2) - oldCanvas.h / 2;

      const newCanvas = {
        w: Math.round(cropBox.w),
        h: Math.round(cropBox.h)
      };

      const nextById: Record<string, Layer> = {};
      layers.order.forEach(id => {
        const layer = layers.byId[id];
        nextById[id] = { ...layer, cx: layer.cx - shiftX, cy: layer.cy - shiftY };
      });

      const { insets } = state.ui.theme.config;

      const newCamera = geometry.camera.getFitCamera(
        state.ui.viewportDim,
        newCanvas,
        { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.left, offsetRight: insets.right }
      );

      actions.updateFrame(activeFrame.id, {
        canvas: newCanvas,
        layers: { byId: nextById, order: layers.order },
        camera: newCamera,
        imageCropBox: asLocalShape({
          x: newCanvas.w * 0.25,
          y: newCanvas.h * 0.25,
          w: newCanvas.w * 0.5,
          h: newCanvas.h * 0.5
        }),
        canvasCropBox: asLocalShape({
          x: newCanvas.w * 0.25,
          y: newCanvas.h * 0.25,
          w: newCanvas.w * 0.5,
          h: newCanvas.h * 0.5
        })
      });
    }
  } as EditorCommand<void, void>,

  resample: {
    id: P.ADV_FRAME_RESAMPLE,
    name: 'Resample Frame',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload: { targetDim: { w: number, h: number } }): Promise<void> => {
      const { activeFrame, state, actions, geometry, layers } = ctx;
      if (!activeFrame) return;

      const { targetDim } = payload;
      const oldW = activeFrame.canvas.w;
      const oldH = activeFrame.canvas.h;

      const scaleX = targetDim.w / oldW;
      const scaleY = targetDim.h / oldH;
      // const isUniform = Math.abs(scaleX - scaleY) < 0.001;

      const patches: Record<string, Partial<Layer>> = {};
      const hostLayers = activeFrame.layers.order.map(id => activeFrame.layers.byId[id]).filter(l => !l.parentId || l.role === 'host');

      for (const layer of hostLayers) {
        try {
          const result = await ctx.layers.resampleLayerPhysical(layer, scaleX, scaleY);
          if (result) {
            patches[layer.id] = result.patch;
          }
        } catch (err) {
          console.error('[FrameService] Resample failed for layer:', layer.id, err);
        }
      }

      const { insets } = state.ui.theme.config;
      const newCamera = geometry.camera.getFitCamera(
        state.ui.viewportDim,
        targetDim,
        { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.left, offsetRight: insets.right }
      );

      actions.updateFrame(activeFrame.id, {
        canvas: targetDim,
        camera: newCamera,
        imageCropBox: asLocalShape({ x: targetDim.w * 0.25, y: targetDim.h * 0.25, w: targetDim.w * 0.5, h: targetDim.h * 0.5 }),
        canvasCropBox: asLocalShape({ x: targetDim.w * 0.25, y: targetDim.h * 0.25, w: targetDim.w * 0.5, h: targetDim.h * 0.5 })
      });

      layers.updateLayer(activeFrame.id, tx => {
        for (const [id, patch] of Object.entries(patches)) {
          tx.edit(id).patch(patch);
        }
      });
    }
  } as EditorCommand<{ targetDim: { w: number, h: number } }, Promise<void>>,
};
