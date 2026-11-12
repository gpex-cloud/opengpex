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
import { createSelectionMoveHandler, createSelectionTransformHandler, createSessionTransformHandler, createReCanvasHandler, createClipBoxHandler, createPathEllipseHandler, createLassoHandler, createWandHandler, createSamHandler, createCommitFreezeHandler } from './interactions';
import { PEEL_COMMANDS, CLIP_ENTRY_COMMANDS } from './commands';
import { peelSessionCodec } from './peel/session';
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
    showDimensionLabel: true,
  },
  interactions: [
    createCommitFreezeHandler(),  // priority 140 — swallows every stage press while a peel commit is baking
    createSelectionMoveHandler(),
    createSessionTransformHandler(),   // priority 125 — peel-session transforms driven through the SELECTION gizmo (the plain selection transform yields while a session is undecided)
    createSelectionTransformHandler(),  // priority 120 — irregular selection scale/rotate handles
    createReCanvasHandler(),    // priority 115 — intercepts Re-Canvas before regular
    createClipBoxHandler(),     // priority 100
    createPathEllipseHandler(),    // priority 100 — path-based ellipse (guarded by handlerKind)
    createLassoHandler(),
    createWandHandler(),
    createSamHandler()
  ],
  contributions: {
    ui: [
      {
        slot: 'SETTINGS_CONFIG_PANEL',
        group: 'viewport',
        component: ClipOverlaySettings,
        title: 'Selection',
        order: 200
      }
    ],
    // The peel session record rides `frame.drafts['peel']`; this plugin owns
    // the record (./helpers/session.ts), so it also owns the hydrate whitelist.
    state: { draftCodec: peelSessionCodec },
  },
  // The peel command family (cmd.peel.*) — plugin-owned domain
  // commands dispatched by id through the central executeCommand registry.
  commands: [...Object.values(PEEL_COMMANDS), ...Object.values(CLIP_ENTRY_COMMANDS)],
};

export default plugin;
