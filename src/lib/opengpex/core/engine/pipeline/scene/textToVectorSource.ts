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
 * textToVectorSource.ts — Business → vector mapping for a text layer (vector
 * spine, third renderer strategy `text`).
 *
 * ARCHITECTURAL ROLE (business → engine boundary): the SOLE place that
 * understands `textData`, sibling to {@link markerToVectorSource} /
 * {@link strokeToVectorSource}. It runs the pure CPU layout
 * (`computeTextLayout` — the single layout source of truth shared with the DOM
 * editor and the retired bitmap painter) ONCE per scene assembly and packs the
 * result into an engine-neutral `vector` {@link LayerSource} carrying
 * {@link TextParams}. The render core consumes those without ever seeing a
 * `Layer` or `textData`; the GPU glyph renderer never re-computes layout.
 *
 * NO FALLBACK (single-track architecture): a text layer with no measure
 * surface (SSR / non-DOM test env) yields `undefined` and the caller falls
 * through to the ordinary raster path — the caller-side `??` chain decides,
 * this mapper never fabricates a bitmap branch.
 *
 * @module core/engine/pipeline/scene/textToVectorSource
 */

import type { Layer, WorkingColorSpace } from '@opengpex/editor/core/types';
import { toWorkingLinearRgba } from '@opengpex/editor/core/engine/color';
import {
  computeTextLayout,
  type TextMeasureContext,
} from '@opengpex/editor/core/engine/text/textLayout';
import type { LayerSource } from './Scene';

/**
 * Shared offscreen measuring surface (Canvas2D satisfies `TextMeasureContext`
 * structurally). Lazily created; `undefined` when no DOM canvas is available —
 * the mapper then reports the layer as not mappable.
 */
let sharedMeasureContext: TextMeasureContext | undefined;

function getMeasureContext(): TextMeasureContext | undefined {
  if (sharedMeasureContext) return sharedMeasureContext;
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  sharedMeasureContext = ctx as unknown as TextMeasureContext;
  return sharedMeasureContext;
}

/**
 * Map a text layer to a `vector` {@link LayerSource} (`renderer: 'text'`), or
 * `undefined` when the layer is not a GPU-text candidate: no `textData`, wrong
 * layer type, or no measure surface in the current environment.
 *
 * `workingSpace` is the document compositing gamut (always `'display-p3'` as
 * assembled — see `SceneAssembler` invariant). The layout is computed at
 * `layer.bounding` (the same extent the compositor places the quad at); the
 * GPU-side density multiplication and atlas banding happen in `TextRenderer`.
 *
 * `measureContext` is injectable for tests; production uses the shared
 * offscreen canvas above.
 */
export function textToVectorSource(
  layer: Layer,
  workingSpace: WorkingColorSpace,
  measureContext?: TextMeasureContext,
): LayerSource | undefined {
  const data = layer.textData;
  if (!data || layer.type !== 'text') return undefined;
  const mc = measureContext ?? getMeasureContext();
  if (!mc) return undefined;

  const w = Math.max(1, layer.bounding?.w ?? 0);
  const h = Math.max(1, layer.bounding?.h ?? 0);

  const layout = computeTextLayout(mc, data, w, h);

  // Straight-alpha working-gamut linear rgba (the shared drawLayer tail applies
  // layer.opacity / blend downstream, exactly as for the other strategies).
  const color = data.color ? toWorkingLinearRgba(data.color, workingSpace) : ([0, 0, 0, 1] as const);

  return {
    kind: 'vector',
    renderer: 'text',
    text: {
      layout,
      fontKey: `${data.fontFamily}|${data.fontWeight || 400}|${data.italic ? 1 : 0}`,
      fontFamily: data.fontFamily,
      fontSize: data.fontSize || 24,
      fontWeight: data.fontWeight || 400,
      italic: data.italic === true,
      color,
      width: w,
      height: h,
    },
  };
}
