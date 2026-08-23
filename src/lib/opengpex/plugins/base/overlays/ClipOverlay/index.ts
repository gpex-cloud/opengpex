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
import { ClipOverlayMain, ClipOverlaySettings } from './components';
import { createSelectionMoveHandler, createReCanvasHandler, createClipBoxHandler, createPathEllipseHandler, createLassoHandler, createWandHandler, createSamHandler } from './interactions';
import * as P from './protocols';

/**
 * ClipOverlay Plugin: Responsible for rendering the interactive cropping layer 
 * on the stage, including masks, grids, and resize handles.
 */

export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Clip Overlay',
    version: '1.0.0',
    description: 'Interactive cropping interface including resize handles, grids, and masks.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none'
    }
  },

  // Main Slot: Renders full-screen stage interaction layer
  slot: 'STAGE_OVERLAY',
  component: ClipOverlayMain,
  initialConfig: {
    maskOpacity: 0.15,
    marchingAntsAnimated: false,
  },
  interactions: [
    createSelectionMoveHandler(),
    createReCanvasHandler(),    // priority 115 — intercepts Re-Canvas before regular
    createClipBoxHandler(),     // priority 100
    createPathEllipseHandler(),    // priority 100 — path-based ellipse (guarded by handlerKind)
    createLassoHandler(),
    createWandHandler(),
    createSamHandler()
  ],
  contributions: [
    {
      slot: 'SETTINGS_CONFIG_PANEL',
      group: 'viewport',
      component: ClipOverlaySettings,
      title: 'Selection',
      order: 200
    }
  ],
  commands: [],
};

export default plugin;
