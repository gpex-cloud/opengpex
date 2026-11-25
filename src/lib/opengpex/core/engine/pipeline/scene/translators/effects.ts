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
 * translators/effects.ts — the layer-effect arm of the business → engine
 * translation seam (SceneTranslator family): `Layer.effects` → declarative
 * `EffectStageDesc[]`.
 *
 * CONTRACT (mirrors `translateLayerAdjustments`):
 *   • One stage per ENABLED effect instance, in the render evaluation order
 *     (`sortEffectInstancesForRender`: shadow beneath, stroke above, then the
 *     chain array order within each category). A disabled instance contributes
 *     no stage — but the TOGGLE itself still dirties the composite signature,
 *     because the serialised chain on the `LayerNode` side is the TRANSLATED
 *     array and an enabled→disabled flip collapses it to a shorter/absent one.
 *   • Colours are resolved ONCE to working-gamut LINEAR straight-alpha RGBA
 *     (`toWorkingLinearRgba` — the same currency the solid / vector translators
 *     emit), so the effect prepass consumes them with zero conversion.
 *   • An all-disabled (or absent) chain yields NO stages, so the node field
 *     collapses back to `undefined` and the composite signature reverts to the
 *     historical no-effects token.
 *
 * P2 scope: only `stroke` stages are emitted. Shadow instances ride the chain
 * and are simply skipped here until the shadow pipeline lands (P5) — their
 * enabled/disabled state therefore does not change pixels yet, which is the
 * honest render behaviour for an unimplemented category.
 *
 * Pure + stateless: same chain + same working space ⇒ deep-equal output.
 *
 * @module core/engine/pipeline/scene/translators/effects
 */

import type { Layer, StrokeParams } from '@opengpex/editor/core/types';
import type { ColorValue } from '@opengpex/editor/core/engine/color/ColorValue';
import { toWorkingLinearRgba } from '@opengpex/editor/core/engine/color';
import type { WorkingColorSpace } from '@opengpex/editor/core/types';
import { getEffectChain, sortEffectInstancesForRender } from '@opengpex/editor/core/layer/effects';
import type { EffectStageDesc } from '../Scene';

function clampStrokeWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 0;
  return widthPx;
}

/**
 * Translate a layer's effect chain into the declarative `Scene` shapes.
 * Returns `undefined` for an empty arm so `LayerNode.effects` stays absent
 * (no effects → no signature contribution — the overwhelmingly common case,
 * and the hydration story for older documents).
 */
export function translateLayerEffects(
  layer: Pick<Layer, 'effects'>,
  workingSpace: WorkingColorSpace,
): { effects?: EffectStageDesc[] } {
  const chain = sortEffectInstancesForRender(getEffectChain(layer as Layer));
  const stages: EffectStageDesc[] = [];
  for (const instance of chain) {
    if (!instance.enabled) continue;
    if (instance.category === 'stroke') {
      const params = instance.params as StrokeParams;
      stages.push({
        kind: 'stroke',
        color: toWorkingLinearRgba(params.color as ColorValue, workingSpace),
        widthPx: clampStrokeWidth(params.widthPx),
        position: params.position ?? 'outside',
      });
    }
    // 'shadow' stages wait for the shadow pipeline (P5) — skipped, not dropped
    // from the data model (the chain keeps the instance; the drawer keeps the tab).
  }
  return { effects: stages.length ? stages : undefined };
}
