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
import { BrushOverlayMain } from './components';
import { createBrushStrokeHandler } from './interactions';
import { BRUSH_OVERLAY_COMMANDS } from './commands';
import * as P from './protocols';

/**
 * BrushOverlay Plugin: Brush cursor + real-time stroke overlay
 *
 * Render in STAGE_OVERLAY layer:
 * - Double-layer circular brush cursor (follows mouse at 60fps)
 * - Real-time stroke preview Canvas (Phase 3 Step 3)
 *
 * Activated when activeCraft is 'brush' or 'eraser'.
 *
 * Interaction priority chain (to be added in Step 2):
 * - brush-stroke (150): Brush stroke interaction
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Brush Overlay',
    version: '1.0.0',
    description: 'Brush cursor and real-time stroke preview overlay for the canvas stage.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none',
    },
  },

  slot: 'STAGE_OVERLAY',
  component: BrushOverlayMain,

  interactions: [
    createBrushStrokeHandler(),  // Priority 150 - Brush stroke interaction
  ],

  commands: BRUSH_OVERLAY_COMMANDS,

  signals: [
    {
      id: P.SIGNAL_IS_STROKING,
      name: 'Is Brush Stroking',
      defaultValue: false,
      scope: 'public',
    },
  ],
};

export default plugin;
