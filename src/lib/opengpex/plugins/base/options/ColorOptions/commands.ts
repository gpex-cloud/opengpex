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

import { EditorCommand, EditorContextValue, asLocalShape } from '@opengpex/editor/core/types';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';

import * as P from './protocols';

/**
 * COLOR_OPTIONS_COMMANDS: Declarative command configuration.
 */
export const COLOR_OPTIONS_COMMANDS = {
  fillAsLayer: {
    id: P.CMD_FILL_AS_LAYER,
    name: 'Fill as New Layer',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { fillColor: string }) => {
      const { state, actions, layers, activeFrame } = ctx;
      if (!activeFrame) return;

      const { fillColor } = payload;
      const isClipMode = state.interaction.interactionMode === 'clip';
      let w, h, box_cx, box_cy;

      if (isClipMode) {
        const clipEntry = getRegularClipShape(activeFrame);
        if (!clipEntry || clipEntry.rect.w <= 0 || clipEntry.rect.h <= 0) {
          actions.setInteraction({ hud: { message: 'No active selection — draw a crop box first.', type: 'error' } });
          return;
        }
        const box = clipEntry.rect;
        w = box.w;
        h = box.h;
        box_cx = box.x + w / 2;
        box_cy = box.y + h / 2;
      } else {
        w = activeFrame.canvas.w;
        h = activeFrame.canvas.h;
        box_cx = activeFrame.canvas.w / 2;
        box_cy = activeFrame.canvas.h / 2;
      }

      const cx = box_cx - activeFrame.canvas.w / 2;
      const cy = box_cy - activeFrame.canvas.h / 2;

      const clipEntry2 = getRegularClipShape(activeFrame);
      const cropType = isClipMode && clipEntry2 ? clipEntry2.type : 'rect';
      const cropAntiAliased = isClipMode && clipEntry2 ? (clipEntry2.antiAliased !== false) : true;

      const newLayer = layers.getNewLayer({
        name: 'Fill Layer',
        type: 'color',
        cx,
        cy,
        locked: true,
        bounding: { w, h },
        visibleShape: asLocalShape({ x: 0, y: 0, w, h }, cropType, cropAntiAliased),
        metadata: { fillColor }
      });

      // Flush fast-track: ensure any in-progress volatile overrides have landed before modifying State
      actions.commitVolatile();

      layers.addLayer(activeFrame.id, newLayer);
      actions.setActiveLayer(activeFrame.id, newLayer.id);

      if (isClipMode) {
        actions.setInteraction({ interactionMode: 'pan' });
      }
    }
  } as EditorCommand<{ fillColor: string }, void>
};
