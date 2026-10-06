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
 * markerToVectorSource.ts — Business → vector mapping for a Marker layer
 * (vector spine, Layer C).
 *
 * ARCHITECTURAL ROLE (business → engine boundary):
 * This is the SOLE place that understands `markerData`. It translates the business
 * model (`MarkerData` + `Layer.bounding`) into an engine-neutral `vector` {@link
 * LayerSource} carrying pure numeric {@link SdfShapeParams} — the render core
 * (`gpu/`, `pipeline/graph/`, `shaders/`) consumes those without ever seeing a
 * `Layer`, a `markerData`, or a `MarkerKind`. The business kind → {@link SdfPrimitive}
 * translation (`'rect' → 'rounded_rect'`, others identity) happens ONLY here. Colours
 * are converted ONCE into the document WORKING gamut (Display-P3) linear light via
 * {@link toWorkingLinearRgba}.
 *
 * @module core/engine/pipeline/scene/markerToVectorSource
 */

import type { Layer, MarkerKind, WorkingColorSpace } from '@opengpex/editor/core/types';
import { toWorkingLinearRgba } from '@opengpex/editor/core/engine/color';
import type { LayerSource, SdfPrimitive } from './Scene';

/** Fill is considered present above this opacity (mirrors "0 = no fill"). */
const FILL_EPSILON = 0.001;

/**
 * Marker business discriminant → engine-owned SDF primitive. This map is the ONLY
 * place the two vocabularies meet: `'rect'` becomes the engine's `'rounded_rect'`
 * (which also covers a zero-radius rectangle), ellipse/arrow keep their names.
 */
const MARKER_KIND_TO_PRIMITIVE: Record<MarkerKind, SdfPrimitive> = {
  rect: 'rounded_rect',
  ellipse: 'ellipse',
  arrow: 'arrow',
};

/**
 * Map a Marker layer to a `vector` {@link LayerSource} (`renderer: 'sdf'`), or
 * `undefined` if the layer is not a marker.
 *
 * `workingSpace` is the document compositing gamut (always `'display-p3'` as
 * assembled — see `SceneAssembler` invariant). `width`/`height` are the layer's
 * BOUNDING dimensions in LOGICAL pixels (`latestLayer.bounding.w/h`) — they become
 * the `LayerNode.width/height` the compositor places the quad at, so the SDF's
 * `size` MUST use the same numbers, not `layer.width` (which may differ from the
 * bounding box). The shader resolves sub-pixel AA at the render target's density
 * via `fwidth`.
 */
export function markerToVectorSource(
  layer: Layer,
  workingSpace: WorkingColorSpace,
  width: number,
  height: number,
): LayerSource | undefined {
  const data = layer.markerData;
  if (!data || layer.type !== 'vector') return undefined;

  const w = Math.max(1, width);
  const h = Math.max(1, height);

  const strokeColor = toWorkingLinearRgba(data.stroke.color, workingSpace);

  // fill is a required field on MarkerDataBase; "no fill" is expressed as opacity 0.
  const fillOpacity = data.fill.opacity ?? 0;
  const fillLinear = toWorkingLinearRgba(data.fill.color, workingSpace);
  const fillColor: readonly [number, number, number, number] = [
    fillLinear[0],
    fillLinear[1],
    fillLinear[2],
    fillLinear[3] * fillOpacity,
  ];

  let shapeParams: readonly [number, number, number, number] = [0, 0, 0, 0];
  let headScale = 0;

  if (data.kind === 'rect') {
    // Corner radius clamped to half the short side (a fuller round can't exist).
    const maxR = Math.min(w, h) / 2;
    const r = Math.min(Math.max(0, data.cornerRadius ?? 0), maxR);
    shapeParams = [r, 0, 0, 0];
  } else if (data.kind === 'arrow') {
    // tail/head are the same layer-local endpoints the CPU path uses
    // (paintMarker.ts::arrowCoverageLayers) — arbitrary direction, not axis-aligned.
    // headLen is derived in-shader as strokeWidth * headScale, keeping ONE formula.
    headScale = data.headScale || 3;
    shapeParams = [data.tail.x, data.tail.y, data.head.x, data.head.y];
  }
  // ellipse: geometry fully implied by `size`; shapeParams stays [0,0,0,0].

  return {
    kind: 'vector',
    renderer: 'sdf',
    sdf: {
      prim: MARKER_KIND_TO_PRIMITIVE[data.kind],
      size: [w, h],
      strokeWidth: data.stroke.width,
      strokeColor,
      hasFill: fillOpacity > FILL_EPSILON,
      fillColor,
      headScale,
      // AA defaults ON: only an explicit `false` on the business data opts out.
      antiAliased: data.antiAliased !== false,
      shapeParams,
    },
  };
}
