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
        { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right }
      );

      actions.updateFrame(activeFrame.id, {
        canvas: newCanvas,
        layers: { byId: nextById, order: layers.order },
        camera: newCamera,
        clipBoxes: {},
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
    execute: async (ctx: EditorContextValue, payload: { targetDim: { w: number, h: number }; dpi?: number }): Promise<void> => {
      const { activeFrame, state, actions, geometry, layers } = ctx;
      if (!activeFrame) return;

      const { targetDim, dpi } = payload;
      const oldW = activeFrame.canvas.w;
      const oldH = activeFrame.canvas.h;

      const scaleX = targetDim.w / oldW;
      const scaleY = targetDim.h / oldH;
      // const isUniform = Math.abs(scaleX - scaleY) < 0.001;

      const patches: Record<string, Partial<Layer>> = {};
      const hostLayers = activeFrame.layers.order.map(id => activeFrame.layers.byId[id]).filter(l => !l.hostId || l.role === 'host');

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
        { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right }
      );

      actions.updateFrame(activeFrame.id, {
        canvas: targetDim,
        camera: newCamera,
        clipBoxes: {},
        canvasCropBox: asLocalShape({ x: targetDim.w * 0.25, y: targetDim.h * 0.25, w: targetDim.w * 0.5, h: targetDim.h * 0.5 }),
        ...(dpi ? { dpi } : {})
      });

      layers.updateLayer(activeFrame.id, tx => {
        for (const [id, patch] of Object.entries(patches)) {
          tx.edit(id).patch(patch);
        }
      });
    }
  } as EditorCommand<{ targetDim: { w: number, h: number }; dpi?: number }, Promise<void>>,

  /**
   * replace — Replace the active frame's primary image layer with externally-provided
   * pixel data (e.g. AI upscale output). Other layers are scaled proportionally.
   *
   * Unlike `resample` which re-interpolates existing pixels, `replace` accepts
   * a new source File containing pre-computed pixel data.
   *
   * Semantics:
   *   - Finds the primary image layer (first host layer with `type === 'image'`)
   *   - Replaces its `src` with the new file (registered as asset)
   *   - Updates canvas dimensions from the new image
   *   - Scales non-primary layers proportionally to fit new canvas
   *   - Preserves undo history
   */
  replace: {
    id: P.ADV_FRAME_REPLACE,
    name: 'Replace Frame Content',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload: { source: File; dpi?: number }): Promise<void> => {
      const { activeFrame, state, actions, geometry, layers, assets } = ctx;
      if (!activeFrame) return;

      const { source, dpi } = payload;

      // 1. Decode the source file to get dimensions
      const bitmap = await createImageBitmap(source);
      const newW = bitmap.width;
      const newH = bitmap.height;
      bitmap.close();

      const oldW = activeFrame.canvas.w;
      const oldH = activeFrame.canvas.h;
      const scaleX = newW / oldW;
      const scaleY = newH / oldH;

      // 2. Register the source as an asset (creates blob URL + cache entry)
      const assetId = await assets.register(source);
      const assetUrl = assets.getURL(assetId)!;

      // 3. Find primary image layer (first host image layer)
      const primaryLayer = activeFrame.layers.order
        .map(id => activeFrame.layers.byId[id])
        .find(l => l.type === 'image' && (!l.hostId || l.role === 'host'));

      if (!primaryLayer) {
        console.error('[FrameReplace] No primary image layer found');
        return;
      }

      // 4. Scale non-primary layers proportionally
      const patches: Record<string, Partial<Layer>> = {};
      const otherHostLayers = activeFrame.layers.order
        .map(id => activeFrame.layers.byId[id])
        .filter(l => l.id !== primaryLayer.id && (!l.hostId || l.role === 'host'));

      for (const layer of otherHostLayers) {
        try {
          const result = await ctx.layers.resampleLayerPhysical(layer, scaleX, scaleY);
          if (result) {
            patches[layer.id] = result.patch;
          }
        } catch (err) {
          console.error('[FrameReplace] Resample failed for layer:', layer.id, err);
        }
      }

      // 5. Patch primary layer: new src + reset transform to fill new canvas
      patches[primaryLayer.id] = {
        src: assetUrl,
        assetId,
        bounding: { w: newW, h: newH },
        visibleShape: asLocalShape({ x: 0, y: 0, w: newW, h: newH }),
        cx: 0,
        cy: 0,
        rotation: 0,
        scale: 1,
      };

      // 6. Update frame canvas + camera
      const targetDim = { w: newW, h: newH };
      const { insets } = state.ui.theme.config;
      const newCamera = geometry.camera.getFitCamera(
        state.ui.viewportDim,
        targetDim,
        { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right }
      );

      actions.updateFrame(activeFrame.id, {
        canvas: targetDim,
        camera: newCamera,
        clipBoxes: {},
        canvasCropBox: asLocalShape({ x: newW * 0.25, y: newH * 0.25, w: newW * 0.5, h: newH * 0.5 }),
        ...(dpi ? { dpi } : {})
      });

      // 7. Apply layer patches
      layers.updateLayer(activeFrame.id, tx => {
        for (const [id, patch] of Object.entries(patches)) {
          tx.edit(id).patch(patch);
        }
      });
    }
  } as EditorCommand<{ source: File; dpi?: number }, Promise<void>>,
};
