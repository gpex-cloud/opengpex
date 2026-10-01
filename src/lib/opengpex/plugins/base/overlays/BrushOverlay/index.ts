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
 * BrushOverlay Plugin: the vector brush tool.
 *
 * A stroke is a `type:'vector'` layer carrying `strokeData`
 * (trajectory + colour + size + hardness), extruded into a ribbon by `cs_extrude`
 * and rasterized by `StrokeRenderer` every composite.
 *
 * Renders in STAGE_OVERLAY. Activated when activeCraft === 'brush'.
 *
 * Interaction priority:
 * - brush-stroke (145): drag the canvas to paint.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Brush Overlay',
    version: '1.0.0',
    description: 'Vector brush overlay — resolution-independent, re-editable strokes.',
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
    createBrushStrokeHandler(), // Priority 145 — paint a stroke
  ],

  commands: BRUSH_OVERLAY_COMMANDS,

  signals: [
    {
      id: P.SIGNAL_DRAWING_STROKE,
      name: 'Is Drawing Stroke',
      defaultValue: false,
      scope: 'public',
    },
  ],
};

export default plugin;
