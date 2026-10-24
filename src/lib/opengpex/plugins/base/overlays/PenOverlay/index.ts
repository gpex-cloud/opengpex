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

import { EditorPlugin } from '@opengpex/editor/core/types';
import { PenOverlayMain } from './components';
import { createPenDblClickActivateHandler, createPenDrawHandler, createPenEditHandler, createPenMoveHandler, createPenResizeHandler, createPenRotateHandler } from './interactions';
import { PEN_OVERLAY_COMMANDS } from './commands';
import { penContributor } from './contribution';
import * as P from './protocols';

/**
 * PenOverlay Plugin: the pen (bézier path) tool.
 *
 * Draws and edits bézier anchor paths on the canvas; commits to feathered
 * vector masks ('Apply as Mask') or the frame's 'pen' selection slot
 * ('Convert to Selection'), and imports the frame's current selection back
 * into an editable draft (AI-result refinement entry).
 *
 * Renders in STAGE_OVERLAY. Activated when activeCraft === 'pen'.
 *
 * Interaction priority:
 * - pen-dblclick-activate (175): pan-mode double-click on a pen layer enters
 *   the tool with that layer selected.
 * - pen-rotate (166) / pen-resize (165): gizmo handle gestures on the active
 *   pen layer (rotate rides the layer channel; resize bakes into penData).
 * - pen-move (162): drag inside a pen layer's visible shape moves the whole
 *   layer; Cmd/Ctrl extends the move onto the path geometry itself.
 * - pen-edit (160): drag/insert anchors on committed pen paths (yields while
 *   a draft session is alive).
 * - pen-draw (145): place anchors into the draft session (ignores meta
 *   presses — Cmd/Ctrl belongs to the transform surface).
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Pen Overlay',
    version: '1.0.0',
    description: 'Pen tool overlay — bézier paths committing to masks and selections.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none',
    },
  },

  slot: 'STAGE_OVERLAY',
  component: PenOverlayMain,

  interactions: [
    createPenDblClickActivateHandler(), // Priority 175 — pan-mode double-click enters the tool
    createPenRotateHandler(), // Priority 166 — gizmo rotate handle on the active pen layer
    createPenResizeHandler(), // Priority 165 — gizmo resize handles (bakes into penData)
    createPenMoveHandler(),   // Priority 162 — Cmd/Ctrl+drag whole-layer move
    createPenEditHandler(),   // Priority 160 — edit committed pen paths
    createPenDrawHandler(),   // Priority 145 — draw a new path
  ],

  commands: PEN_OVERLAY_COMMANDS,

  contributions: {
    engine: { vectorSource: penContributor },
  },

  signals: [
    {
      id: P.SIGNAL_PEN_PHASE,
      name: 'Pen Phase',
      defaultValue: 'idle',
      scope: 'public',
    },
  ],
};

export default plugin;
