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

import { EditorCommand, EditorContextValue, Frame } from '@opengpex/editor/core/types';
import { transformFrame } from '@opengpex/editor/core/geometry/operators/transform';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * VIEWPORT_TRANSFORM_COMMANDS: Handles core geometric transformations (rotation, flip, reset) for viewports and layers.
 */
export const ViewportTransformCommands = {
  rotate: {
    id: P.ADV_VIEWPORT_ROTATE,
    name: 'Rotate Frame',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { direction: 'left' | 'right' }): void => {
      const { activeFrame, actions } = ctx;
      if (!activeFrame) return;

      actions.fast.reset();

      const operation = payload.direction === 'right' ? 'rotate_r' : 'rotate_l';
      const nextFramePatch = transformFrame(activeFrame, operation);

      actions.updateFrame(activeFrame.id, {
        ...nextFramePatch,
        imageCropBox: nextFramePatch.imageCropBox,
        canvasCropBox: nextFramePatch.canvasCropBox,
        imageAspect: activeFrame.imageAspect ? 1 / activeFrame.imageAspect : undefined,
        canvasAspect: activeFrame.canvasAspect ? 1 / activeFrame.canvasAspect : undefined
      });
    }
  } as EditorCommand<{ direction: 'left' | 'right' }, void>,

  rotateLeft: {
    id: P.ADV_VIEWPORT_ROTATE_LEFT,
    name: 'Rotate Left',
    undoable: true,
    execute: (ctx: EditorContextValue) => ViewportTransformCommands.rotate.execute(ctx, { direction: 'left' }),
    shortcuts: [{ key: '[' }]
  } as EditorCommand<void, void>,

  rotateRight: {
    id: P.ADV_VIEWPORT_ROTATE_RIGHT,
    name: 'Rotate Right',
    undoable: true,
    execute: (ctx: EditorContextValue) => ViewportTransformCommands.rotate.execute(ctx, { direction: 'right' }),
    shortcuts: [{ key: ']' }]
  } as EditorCommand<void, void>,

  flip: {
    id: P.ADV_VIEWPORT_FLIP,
    name: 'Flip Frame',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { direction: 'horizontal' | 'vertical' }): void => {
      const { activeFrame, actions } = ctx;
      if (!activeFrame) return;

      actions.fast.reset();

      const operation = payload.direction === 'horizontal' ? 'flip_h' : 'flip_v';
      const nextFramePatch = transformFrame(activeFrame, operation);

      actions.updateFrame(activeFrame.id, {
        ...nextFramePatch,
        imageCropBox: nextFramePatch.imageCropBox,
        canvasCropBox: nextFramePatch.canvasCropBox,
      });
    }
  } as EditorCommand<{ direction: 'horizontal' | 'vertical' }, void>,

  flipH: {
    id: P.ADV_VIEWPORT_FLIP_H,
    name: 'Flip Horizontal',
    undoable: true,
    execute: (ctx: EditorContextValue) => ViewportTransformCommands.flip.execute(ctx, { direction: 'horizontal' }),
    shortcuts: [{ key: 'h', shift: true }]
  } as EditorCommand<void, void>,

  flipV: {
    id: P.ADV_VIEWPORT_FLIP_V,
    name: 'Flip Vertical',
    undoable: true,
    execute: (ctx: EditorContextValue) => ViewportTransformCommands.flip.execute(ctx, { direction: 'vertical' }),
    shortcuts: [{ key: 'v', shift: true }]
  } as EditorCommand<void, void>,

  reset: {
    id: P.ADV_VIEWPORT_RESET,
    name: 'Reset Transform',
    undoable: true,
    execute: (ctx: EditorContextValue): void => {
      const { activeFrame, actions } = ctx;
      if (!activeFrame) return;

      actions.fast.reset();

      const baseLayer = activeFrame.layers.byId[activeFrame.layers.order[0]];
      if (!baseLayer) return;

      const currentRot = ((baseLayer.rotation % 360) + 360) % 360;

      let nextFrame: Frame = activeFrame;

      if (currentRot === 90) {
        nextFrame = { ...nextFrame, ...transformFrame(nextFrame, 'rotate_l') };
      } else if (currentRot === 180) {
        nextFrame = { ...nextFrame, ...transformFrame(nextFrame, 'rotate_l') };
        nextFrame = { ...nextFrame, ...transformFrame(nextFrame, 'rotate_l') };
      } else if (currentRot === 270) {
        nextFrame = { ...nextFrame, ...transformFrame(nextFrame, 'rotate_r') };
      }

      const currentBase = nextFrame.layers.byId[nextFrame.layers.order[0]];
      if (currentBase.flip.h) {
        nextFrame = { ...nextFrame, ...transformFrame(nextFrame, 'flip_h') };
      }
      if (currentBase.flip.v) {
        nextFrame = { ...nextFrame, ...transformFrame(nextFrame, 'flip_v') };
      }

      actions.updateFrame(activeFrame.id, {
        canvas: nextFrame.canvas,
        rotation: 0,
        layers: nextFrame.layers,
        imageCropBox: nextFrame.imageCropBox,
        canvasCropBox: nextFrame.canvasCropBox,
        camera: nextFrame.camera
      });
    },
    shortcuts: [{ key: 'r', meta: true, alt: true }, { key: 'r', ctrl: true, alt: true }]
  } as EditorCommand<void, void>
};
