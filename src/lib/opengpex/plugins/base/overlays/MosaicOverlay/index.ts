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
import { MosaicOverlayMain } from './components';
import { createMosaicStrokeHandler } from './interactions';
import { MOSAIC_OVERLAY_COMMANDS } from './commands';
import * as P from './protocols';

/**
 * MosaicOverlay Plugin: Mosaic cursor + real-time pixelation stroke overlay
 *
 * Render in STAGE_OVERLAY layer:
 * - Double-layer circular cursor with mosaic badge (follows mouse at 60fps)
 * - Real-time pixelated stroke preview Canvas
 *
 * Activated when activeCraft is 'mosaic'.
 *
 * Interaction priority:
 * - mosaic-stroke (150): Mosaic stroke interaction
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Mosaic Overlay',
    version: '1.0.0',
    description: 'Mosaic cursor and real-time stroke preview overlay for the canvas stage.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none',
    },
  },

  slot: 'STAGE_OVERLAY',
  component: MosaicOverlayMain,

  interactions: [
    createMosaicStrokeHandler(),  // Priority 150 - Mosaic stroke interaction
  ],

  commands: MOSAIC_OVERLAY_COMMANDS,

  signals: [
    {
      id: P.SIGNAL_IS_STROKING,
      name: 'Is Mosaic Stroking',
      defaultValue: false,
      scope: 'public',
    },
  ],
};

export default plugin;
