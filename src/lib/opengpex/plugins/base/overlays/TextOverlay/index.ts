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
import { TextOverlayMain } from './components';
import { createTextMoveHandler, createTextResizeHandler, createTextRotateHandler, createTextPlaceHandler } from './interactions';
import { TEXT_OVERLAY_COMMANDS } from './commands';
import * as P from './protocols';

/**
 * TextOverlay Plugin: Text inline editing DOM overlay
 *
 * Render text editor (contenteditable) in STAGE_OVERLAY layer.
 * Activated when activeCraft === 'text', providing click/drag-to-place + inline
 * editing capabilities with two-stage click arbitration (click empty canvas
 * while editing commits the session; the next click creates).
 *
 * Interaction priority chain:
 * - text-move (170): Cmd/Ctrl + drag to move text layer (independent undoable transaction)
 * - text-rotate (165): pre-edit drag of the LayerOverlay rotation handle
 * - text-resize (160): pre-edit drag of the LayerOverlay resize handles
 * - text-place (150): two-stage arbitration + click/drag-to-place
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Text Overlay',
    version: '1.0.0',
    description: 'Inline text editing overlay for the canvas stage.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none',
    },
  },

  slot: 'STAGE_OVERLAY',
  component: TextOverlayMain,

  interactions: [
    createTextMoveHandler(),    // Priority 170 - Cmd+drag to move (highest)
    createTextRotateHandler(),  // Priority 165 - drag rotation handle
    createTextResizeHandler(),  // Priority 160 - editing state resize handle
    createTextPlaceHandler(),   // Priority 150 - place/wake up
  ],

  commands: TEXT_OVERLAY_COMMANDS,

  signals: [
    {
      id: P.SIGNAL_EDITING_TEXT_LAYER_ID,
      name: 'Editing Text Layer ID',
      defaultValue: null,
      scope: 'public',
    },
    {
      id: P.SIGNAL_PLACE_MARQUEE,
      name: 'Text Place Marquee Rect',
      defaultValue: null,
      scope: 'private',
    },
  ],
};

export default plugin;
