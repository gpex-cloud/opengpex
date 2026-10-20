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
 * vectorSource.ts — the marker plugin's translation into the engine's vector
 * source vocabulary: business `markerData` → `renderer: 'sdf'` LayerSource.
 *
 * This is the plugin's ENTIRE exposure to the engine's scene assembly. It
 * imports only engine public exports (colour conversion + types) and the
 * shapes' React-free `render.ts` modules; the engine never imports this module —
 * the contributor is wired through the plugin registry's
 * `contributions.engine.vectorSource` slot.
 *
 * @module plugins/base/overlays/MarkerOverlay/contribution
 */

import type { Layer } from '@opengpex/editor/core/types';
import type { MarkerData, MarkerBounding, SdfGeometry } from './marker/types';
import { toWorkingLinearRgba } from '@opengpex/editor/core/engine/color';
import type {
  LayerSource,
  VectorSourceContributor,
  VectorSourceContext,
} from '@opengpex/editor/core/engine/pipeline/scene/vectorSources';
import { rectToSdf } from './marker/shapes/rect/render';
import { ellipseToSdf } from './marker/shapes/ellipse/render';
import { arrowToSdf } from './marker/shapes/arrow/render';
import { lineToSdf } from './marker/shapes/line/render';
import { darrowToSdf } from './marker/shapes/darrow/render';
import { starToSdf } from './marker/shapes/star/render';
import { polygonToSdf } from './marker/shapes/polygon/render';
import { calloutToSdf } from './marker/shapes/callout/render';

/** Fill is considered present above this opacity (mirrors "0 = no fill"). */
const FILL_EPSILON = 0.001;

/**
 * Business kind → engine SDF geometry. Each kind owns its translation in
 * `shapes/<kind>/render.ts` (render-side, React-free); this switch is the ONLY
 * place the business discriminant meets the engine primitive vocabulary.
 */
function markerToSdfGeometry(data: MarkerData, size: MarkerBounding): SdfGeometry {
  switch (data.kind) {
    case 'rect':
      return rectToSdf(data, size);
    case 'ellipse':
      return ellipseToSdf(data, size);
    case 'arrow':
      return arrowToSdf(data, size);
    case 'line':
      return lineToSdf(data, size);
    case 'darrow':
      return darrowToSdf(data, size);
    case 'star':
      return starToSdf(data, size);
    case 'polygon':
      return polygonToSdf(data, size);
    case 'callout':
      return calloutToSdf(data, size);
    default: {
      const _never: never = data;
      void _never;
      throw new Error('unknown marker kind');
    }
  }
}

/**
 * Map a Marker layer to a `vector` {@link LayerSource} (`renderer: 'sdf'`), or
 * `undefined` if the layer is not a marker.
 *
 * `ctx.workingSpace` is the document compositing gamut (always `WORKING_GAMUT`,
 * ProPhoto RGB — see `SceneAssembler` invariant). `ctx.width`/`ctx.height` are the
 * layer's BOUNDING dimensions in LOGICAL pixels (`latestLayer.bounding.w/h`) — they
 * become the `LayerNode.width/height` the compositor places the quad at, so the
 * SDF's `size` MUST use the same numbers, not `layer.width` (which may differ from
 * the bounding box). The shader resolves sub-pixel AA at the render target's density
 * via `fwidth`.
 */
function markerToVectorSource(
  layer: Layer,
  ctx: VectorSourceContext,
): LayerSource | undefined {
  const data = layer.markerData;
  if (!data || layer.type !== 'vector') return undefined;

  const w = Math.max(1, ctx.width ?? 0);
  const h = Math.max(1, ctx.height ?? 0);

  const strokeColor = toWorkingLinearRgba(data.stroke.color, ctx.workingSpace);

  // fill is a required field on MarkerDataBase; "no fill" is expressed as opacity 0.
  const fillOpacity = data.fill.opacity ?? 0;
  const fillLinear = toWorkingLinearRgba(data.fill.color, ctx.workingSpace);
  const fillColor: readonly [number, number, number, number] = [
    fillLinear[0],
    fillLinear[1],
    fillLinear[2],
    fillLinear[3] * fillOpacity,
  ];

  const geometry = markerToSdfGeometry(data, { w, h });

  return {
    kind: 'vector',
    renderer: 'sdf',
    sdf: {
      prim: geometry.prim,
      size: [w, h],
      strokeWidth: data.stroke.width,
      strokeColor,
      hasFill: fillOpacity > FILL_EPSILON,
      fillColor,
      headScale: geometry.headScale ?? 0,
      // AA defaults ON: only an explicit `false` on the business data opts out.
      antiAliased: data.antiAliased !== false,
      shapeParams: geometry.shapeParams,
    },
  };
}

/** The marker plugin's entire exposure to the engine's vector-source registry. */
export const markerContributor: VectorSourceContributor = {
  toolId: 'marker',
  translate: markerToVectorSource,
};
