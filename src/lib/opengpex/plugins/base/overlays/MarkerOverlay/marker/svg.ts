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

/**
 * markerSvg.ts — SVG preview fragments for annotation markers.
 *
 * Markers render on the GPU via the vector spine's analytic SDF strategy (see
 * `core/engine/gpu/shaders/sdf.ts`); this module only provides `markerToSvg`, used
 * by the drag-preview overlay to mirror the on-canvas shape while a marker is being
 * drawn/resized. It is a pure dispatcher: each kind draws itself in its own
 * `shapes/<kind>/render.ts` (render-side, React-free), so this file and the shape
 * render modules never pull UI dependencies into the preview path.
 *
 * Colors go out as CSS Color 4 `color()` values, never `.hex` — hex is the lossy
 * clamp+quantize view, so a wide-gamut marker would preview visibly duller
 * mid-drag and snap vivid on commit. Requires an engine that accepts `color()`
 * in SVG presentation attributes (Chromium 111+, Safari 15+); older engines
 * fall back to the initial fill (black).
 *
 * @module plugins/base/overlays/MarkerOverlay/marker/svg
 */

import type { MarkerData, MarkerBounding } from './types';
import { rectToSvg } from './shapes/rect/render';
import { ellipseToSvg } from './shapes/ellipse/render';
import { arrowToSvg } from './shapes/arrow/render';
import { lineToSvg } from './shapes/line/render';
import { darrowToSvg } from './shapes/darrow/render';
import { starToSvg } from './shapes/star/render';
import { polygonToSvg } from './shapes/polygon/render';
import { calloutToSvg } from './shapes/callout/render';

export type { MarkerBounding } from './types';

/**
 * markerToSvg: build an SVG fragment string for a marker (layer-local origin).
 */
export function markerToSvg(markerData: MarkerData, bounding: MarkerBounding): string {
  switch (markerData.kind) {
    case 'rect':
      return rectToSvg(markerData, bounding);
    case 'ellipse':
      return ellipseToSvg(markerData, bounding);
    case 'arrow':
      return arrowToSvg(markerData);
    case 'line':
      return lineToSvg(markerData);
    case 'darrow':
      return darrowToSvg(markerData);
    case 'star':
      return starToSvg(markerData, bounding);
    case 'polygon':
      return polygonToSvg(markerData, bounding);
    case 'callout':
      return calloutToSvg(markerData, bounding);
    default: {
      const _never: never = markerData;
      void _never;
      return '';
    }
  }
}
