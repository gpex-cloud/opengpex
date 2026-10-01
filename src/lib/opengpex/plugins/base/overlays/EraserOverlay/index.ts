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
import { EraserOverlayMain } from './components';
import { createEraserStrokeHandler } from './interactions';
import * as P from './protocols';

/**
 * EraserOverlay Plugin: eraser/restore cursor + real-time mask stroke overlay.
 *
 * Render in STAGE_OVERLAY layer:
 * - Dashed circular brush cursor (follows mouse at 60fps)
 * - Rubylith mask-focus overlay (shows what the mask hides/reveals)
 * - Live mask preview via `fast.override` (no separate stroke buffer)
 *
 * Activated when activeCraft is 'eraser' or 'restore'. Edits go to layer
 * bitmap masks through the core `adv.layer.bitmapMask` actions, so this plugin
 * registers NO custom command (unlike the raster brush's CMD_BAKE).
 *
 * Interaction priority:
 * - eraser-stroke (150): mask stroke interaction
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Eraser Overlay',
    version: '1.0.0',
    description: 'Eraser/restore cursor and non-destructive bitmap mask stroke overlay.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none',
    },
  },

  slot: 'STAGE_OVERLAY',
  component: EraserOverlayMain,

  interactions: [
    createEraserStrokeHandler(),  // Priority 150 - Mask stroke interaction
  ],

  commands: [],

  signals: [
    {
      id: P.SIGNAL_IS_STROKING,
      name: 'Is Eraser Stroking',
      defaultValue: false,
      scope: 'public',
    },
  ],
};

export default plugin;
