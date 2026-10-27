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

import {
  EditorContextValue,
  EditorCommand,
  Layer,
} from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import * as P from './protocols';

// ─── Commands ──────────────────────────────────────────────────────────────────

/**
 * cmd.place: places ONE stroke's own layer above the active layer and
 * activates it (ONE STROKE = ONE LAYER; multi-stroke grouping is manual, via
 * layer groups in the layers panel).
 *
 * undoable: true → this is the gesture's ONLY undo checkpoint, taken at the
 * FIRST drawable sample — the layer created here is already the real,
 * user-visible layer (its name is stable for the whole gesture; nothing gets
 * created or renamed at pointerup). The in-progress trajectory afterwards
 * rides the silent volatile track (`InteractionTransaction.begin(silent)`,
 * which takes no checkpoint) onto this same layer, and the pointerup tighten
 * commits through that same track. One undo step removes the stroke layer.
 */
const placeCommand: EditorCommand<{ frameId: string; layer: Layer }, void> = {
  id: P.CMD_PLACE,
  name: 'Place Stroke Layer',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layer: Layer }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    if (!frame) return;

    const below = LayerFactory.resolveActiveHostLayer(frame);
    const insertAt = LayerFactory.getInsertIndexAbove(frame, below?.id);
    ctx.layers.addLayer(payload.frameId, payload.layer, insertAt);
    ctx.layers.activate(payload.frameId, payload.layer.id);
  },
};

// ─── Export ────────────────────────────────────────────────────────────────────

export const BRUSH_OVERLAY_COMMANDS = [placeCommand];
