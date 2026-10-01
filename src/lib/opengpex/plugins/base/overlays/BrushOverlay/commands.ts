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
import { LayerFactory } from '@opengpex/editor/core/layer';
import * as P from './protocols';

// ─── Commands ──────────────────────────────────────────────────────────────────

/**
 * cmd.place: Places a freshly started logic-brush stroke as a `type:'vector'`
 * layer, directly above the active layer.
 *
 * ONE STROKE = ONE LAYER. Deliberately simpler than MarkerOverlay's place
 * command, which auto-groups consecutively drawn markers: a painting tool emits
 * strokes in rapid succession, so the same rule would spawn a group as soon as
 * the user drew twice. Strokes stay plain sibling layers; the user groups them
 * by hand if they want to.
 *
 * undoable: true → this is the ONLY undo checkpoint of a stroke gesture. The
 * whole in-progress trajectory afterwards rides the volatile fast track
 * (`InteractionTransaction.begin(silent)`, which does not signal a checkpoint),
 * and the pointerup commit writes it through `fast.commit`, which does not
 * either. Net result: one stroke = exactly one undo step, reverting to before
 * the pen touched down.
 */
const placeCommand: EditorCommand<{ frameId: string; layer: Layer }, void> = {
  id: P.CMD_PLACE,
  name: 'Place Stroke Layer',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layer: Layer }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    if (!frame) return;

    // Land directly above the active layer (getInsertIndexAbove resolves group /
    // host targets); undefined index falls back to append-on-top in the reducer.
    const below = LayerFactory.resolveActiveHostLayer(frame);
    const insertAt = LayerFactory.getInsertIndexAbove(frame, below?.id);

    ctx.layers.addLayer(payload.frameId, payload.layer, insertAt);
    ctx.layers.activate(payload.frameId, payload.layer.id);
  },
};

// ─── Export ────────────────────────────────────────────────────────────────────

export const BRUSH_OVERLAY_COMMANDS = [placeCommand];
