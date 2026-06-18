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
import { LayerOverlayContainer, LayerOverlayToggle } from './components';
import { LAYER_OVERLAY_COMMANDS } from './commands';
import * as P from './protocols';

/**
 * LayerOverlay Plugin: Provides stage layer helper lines and selection state display.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Layer Overlay',
    version: '1.0.0',
    description: 'Provides selection handles and alignment indicators for layers.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none'
    }
  },
  slot: 'STAGE_OVERLAY',
  show: 'frame-required',
  component: LayerOverlayContainer,
  order: 10,
  initialConfig: { showAlways: false },
  commands: Object.values(LAYER_OVERLAY_COMMANDS),
  contributions: [
    {
      slot: 'TOOL_MENU',
      component: LayerOverlayToggle,
      order: 2020
    }
  ]
};

export default plugin;
