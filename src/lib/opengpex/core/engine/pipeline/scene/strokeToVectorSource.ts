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
 * strokeToVectorSource.ts — Business → vector mapping for a vector-brush
 * layer (vector spine, second renderer strategy `stroke`).
 *
 * ARCHITECTURAL ROLE (business → engine boundary):
 * The SOLE place that understands `strokeData`, sibling to {@link
 * markerToVectorSource}. It translates the business model ({@link StrokeData} +
 * `Layer.bounding`) into an engine-neutral `vector` {@link LayerSource} carrying pure
 * numeric {@link StrokeParams} — the render core (`gpu/`, `pipeline/graph/`,
 * `shaders/`) consumes those without ever seeing a `Layer` or a `strokeData`. Colour is
 * converted ONCE into the document WORKING gamut (Display-P3) LINEAR light (straight
 * alpha) via {@link toWorkingLinearRgba}, and the trajectory is packed into the
 * `[x, y, width, _pad] × N` layout the `cs_extrude` compute pass reads — where
 * `width` is the effective tip DIAMETER (`size × pressure`), not the raw pressure.
 *
 * @module core/engine/pipeline/scene/strokeToVectorSource
 */

import type { Layer, WorkingColorSpace } from '@opengpex/editor/core/types';
import { toWorkingLinearRgba } from '@opengpex/editor/core/engine/color';
import type { LayerSource } from './Scene';

/** Float32 lanes per packed point: [x, y, width, _pad] (mirrors the WGSL `Pt`). */
const FLOATS_PER_POINT = 4;

/**
 * Map a logic-brush layer to a `vector` {@link LayerSource} (`renderer: 'stroke'`),
 * or `undefined` if the layer carries no `strokeData`.
 *
 * `workingSpace` is the document compositing gamut (always `'display-p3'` as
 * assembled — see `SceneAssembler` invariant). `width`/`height` are read from the
 * layer's BOUNDING box (`layer.bounding.w/h`, same source the marker branch uses for
 * `SdfShapeParams.size`): they become the `LayerNode.width/height` the compositor
 * places the quad at, and the StrokeRenderer's vertex shader divides the logical-pixel
 * trajectory by them to reach NDC (see {@link StrokeParams.width}).
 */
export function strokeToVectorSource(
  layer: Layer,
  workingSpace: WorkingColorSpace,
): LayerSource | undefined {
  const data = layer.strokeData;
  if (!data || layer.type !== 'vector') return undefined;

  const w = Math.max(1, layer.bounding?.w ?? 0);
  const h = Math.max(1, layer.bounding?.h ?? 0);

  // Straight-alpha working-gamut linear rgba (never premultiplied here — the
  // StrokeRenderer emits STRAIGHT alpha and the shared drawLayer tail applies
  // layer.opacity / blend downstream).
  const color = toWorkingLinearRgba(data.color, workingSpace);

  // Pack the trajectory into [x, y, width, _pad] × N — the exact `Pt` layout
  // `cs_extrude` reads. `_pad` stays 0 (WGSL struct alignment lane).
  //
  // WIDTH LANE: the compute pass extrudes `half-width = lane * 0.5` and has no
  // access to the paint uniform's `size`, so the EFFECTIVE TIP DIAMETER
  // (`size × pressure`) has to ride the point stream. Packing raw 0..1 pressure here
  // would render every stroke as a ≤1px hairline regardless of the brush size.
  const pointCount = data.points.length;
  const points = new Float32Array(pointCount * FLOATS_PER_POINT);
  for (let i = 0; i < pointCount; i++) {
    const p = data.points[i];
    const base = i * FLOATS_PER_POINT;
    points[base + 0] = p.x;
    points[base + 1] = p.y;
    points[base + 2] = data.size * p.pressure;
    points[base + 3] = 0;
  }

  return {
    kind: 'vector',
    renderer: 'stroke',
    stroke: {
      points,
      pointCount,
      color,
      size: data.size,
      hardness: data.hardness,
      // Normalize: undefined = AA on (zero-regression default for legacy strokes).
      antiAliased: data.antiAliased !== false,
      width: w,
      height: h,
    },
  };
}
