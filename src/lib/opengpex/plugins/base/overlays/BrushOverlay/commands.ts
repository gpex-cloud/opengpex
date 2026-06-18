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

import { EditorContextValue, EditorCommand, Layer } from '@opengpex/editor/core/types';
import * as P from './protocols';

// ─── Commands ──────────────────────────────────────────────────────────────────

/**
 * cmd.bake: Bake the stroke to target layer
 *
 * undoable: true → Automatically establish SIGNAL_COMMIT undo baseline before execution.
 * Called after each stroke completion, ensuring each stroke generates an independent Undo Step.
 */
const bakeCommand: EditorCommand<{ frameId: string; layer: Layer; isNew: boolean }, void> = {
  id: P.CMD_BAKE,
  name: 'Bake Brush Stroke',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layer: Layer; isNew: boolean }) => {
    if (payload.isNew) {
      // Pass through complete pipeline via LayerService.addLayer (expandLayers + cascade calculation),
      // ensuring the paint layer supports subsequent operations like peel that generate child layers.
      ctx.layers.addLayer(payload.frameId, payload.layer);
      ctx.layers.activate(payload.frameId, payload.layer.id);
    } else {
      ctx.actions.updateLayer(payload.frameId, payload.layer.id, {
        assetId: payload.layer.assetId,
        src: payload.layer.src,
        bounding: payload.layer.bounding,
      });
    }
  },
};

// ─── Export ────────────────────────────────────────────────────────────────────

export const BRUSH_OVERLAY_COMMANDS = [
  bakeCommand,
];
