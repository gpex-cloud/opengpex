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

import { EditorPlugin } from '@opengpex/editor/core/types';
import { PixelGridOverlayContainer, PixelGridToggle } from './components';
import { PIXEL_GRID_COMMANDS } from './commands';
import * as P from './protocols';

/**
 * PixelGridOverlay Plugin: Renders a 1px physical grid aligned with image pixels at high zoom levels.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Pixel Grid Overlay',
    version: '1.0.0',
    description: 'Displays a pixel-perfect grid when zoomed in past a threshold.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none'
    }
  },
  slot: 'STAGE_OVERLAY',
  show: 'frame-required',
  component: PixelGridOverlayContainer,
  order: 15,
  initialConfig: {
    enabled: true,
    hardEdge: false,
    zoomThreshold: 8,
    color: 'rgba(255, 255, 255, 0.2)'
  },
  commands: Object.values(PIXEL_GRID_COMMANDS),
  contributions: [
    {
      slot: 'TOOL_MENU',
      component: PixelGridToggle,
      order: 2030
    }
  ]
};

export default plugin;
