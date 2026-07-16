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

import { EditorCommand, EditorContextValue, LocalShape, asLocalShape } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';

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
      let w: number, h: number, box_cx: number, box_cy: number;
      let visibleShape: LocalShape;

      if (isClipMode) {
        const box = getClipBox(activeFrame);
        if (!box) {
          actions.setInteraction({ hud: { message: 'No active selection — draw a crop box first.', type: 'error' } });
          return;
        }

        if (box.regular) {
          // ═══ Regular selection (rect/ellipse) ═══
          const shape = box.spatial;
          if (shape.rect.w <= 0 || shape.rect.h <= 0) {
            actions.setInteraction({ hud: { message: 'No active selection — draw a crop box first.', type: 'error' } });
            return;
          }
          w = shape.rect.w;
          h = shape.rect.h;
          box_cx = shape.rect.x + w / 2;
          box_cy = shape.rect.y + h / 2;
          visibleShape = asLocalShape({ x: 0, y: 0, w, h }, shape.type, shape.antiAliased !== false);
        } else {
          // ═══ Irregular selection (lasso/wand polygon) ═══
          const poly = box.spatial;
          const bounds = poly.rect;
          if (bounds.w <= 0 || bounds.h <= 0) {
            actions.setInteraction({ hud: { message: 'No active selection — draw a crop box first.', type: 'error' } });
            return;
          }
          w = bounds.w;
          h = bounds.h;
          box_cx = bounds.x + w / 2;
          box_cy = bounds.y + h / 2;

          // Build path data in layer-local coordinates (offset by -bounds origin)
          const parts: string[] = [];
          for (const ring of poly.rings) {
            if (ring.length < 2) continue;
            const segs: string[] = [];
            for (let i = 0; i < ring.length; i++) {
              const p = ring[i];
              segs.push(`${i === 0 ? 'M' : 'L'} ${p.x - bounds.x} ${p.y - bounds.y}`);
            }
            segs.push('Z');
            parts.push(segs.join(' '));
          }

          visibleShape = {
            type: 'path',
            rect: { x: 0, y: 0, w, h },
            antiAliased: poly.antiAliased !== false,
            pathData: parts.join(' '),
            __brand: 'local',
          } as LocalShape;
        }
      } else {
        w = activeFrame.canvas.w;
        h = activeFrame.canvas.h;
        box_cx = activeFrame.canvas.w / 2;
        box_cy = activeFrame.canvas.h / 2;
        visibleShape = asLocalShape({ x: 0, y: 0, w, h }, 'rect', true);
      }

      const cx = box_cx - activeFrame.canvas.w / 2;
      const cy = box_cy - activeFrame.canvas.h / 2;

      const newLayer = layers.getNewLayer({
        name: 'Fill Layer',
        type: 'color',
        cx,
        cy,
        locked: true,
        bounding: { w, h },
        visibleShape,
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
  } as EditorCommand<{ fillColor: string }, void>,

  sampleColor: {
    id: P.CMD_SAMPLE_COLOR,
    name: 'Sample Color',
    undoable: false,
    shortcut: { key: 'i' },
    execute: () => {
      // Toggle sampling mode via DOM event (ephemeral, not persisted)
      window.dispatchEvent(new CustomEvent('coloroptions:toggle-sampler'));
    }
  } as EditorCommand<void, void>
};
