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
import { MarkerOverlayMain } from './components';
import { createMarkerMoveHandler, createMarkerDrawHandler, createMarkerResizeHandler } from './interactions';
import { MARKER_OVERLAY_COMMANDS } from './commands';
// Side-effect import: registers built-in markers (rect, arrow) into MARKER_REGISTRY.
import './markers';
import * as P from './protocols';

/**
 * MarkerOverlay Plugin: annotation marker drawing overlay (rect, arrow, …).
 *
 * Renders in STAGE_OVERLAY. Activated when activeCraft === 'marker'.
 *
 * Interaction priority chain (marker handlers are craft+marker gated):
 * - marker-resize (160): drag a selection handle to resize the active marker (highest)
 * - marker-move (155): drag an existing marker layer to move it (wins on hit)
 * - marker-draw (145): drag empty canvas to draw a new marker layer
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Marker Overlay',
    version: '1.0.0',
    description: 'Marker drawing overlay — rect, arrow and more.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none',
    },
  },

  slot: 'STAGE_OVERLAY',
  component: MarkerOverlayMain,

  interactions: [
    createMarkerResizeHandler(),  // Priority 160 — resize active marker (highest)
    createMarkerMoveHandler(),    // Priority 155 — move existing marker
    createMarkerDrawHandler(),    // Priority 145 — draw new marker
  ],

  commands: MARKER_OVERLAY_COMMANDS,

  signals: [
    {
      id: P.SIGNAL_DRAWING_MARKER,
      name: 'Is Drawing Marker',
      defaultValue: false,
      scope: 'public',
    },
  ],
};

export default plugin;
