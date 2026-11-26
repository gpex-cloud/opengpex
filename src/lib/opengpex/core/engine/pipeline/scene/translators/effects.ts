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
 * Scope: `stroke`, `shadow`, the two surface overlays, the outer glow and the inner-edge family are emitted; categories
 * without a render pipeline yet are skipped here — their enabled/disabled
 * state does not change pixels, the honest render behaviour for an
 * unimplemented category (the chain keeps the instance; the drawer keeps the tab).
 *
 * Pure + stateless: same chain + same working space ⇒ deep-equal output.
 *
 * @module core/engine/pipeline/scene/translators/effects
 */

import type { Layer, StrokeParams, ShadowParams, ColorOverlayParams, OuterGlowParams, GradientOverlayParams, InnerGlowParams, InnerShadowParams, LayerBlendMode } from '@opengpex/editor/core/types';
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
 * Sanitize one shadow scalar: non-finite → fallback, negatives clamped for
 * the magnitude-style fields (sigma / opacity); the OFFSET components keep
 * their sign (they are deltas, not magnitudes) and only drop non-finites.
 */
function clampShadowScalar(v: number, fallback: number, min = 0, max = Infinity): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function clampShadowOffset(v: number): number {
  if (!Number.isFinite(v)) return 0;
  // Guard against absurd deltas that would explode the ROI window.
  return Math.min(1000, Math.max(-1000, v));
}

/**
 * Guard the overlay blend mode: only the 16 `LayerBlendMode` members render;
 * anything else (corrupted document, hand-edited JSON) falls back to the
 * Multiply default — the same Photoshop factory default the chain uses.
 */
function sanitizeOverlayBlendMode(mode: unknown): LayerBlendMode {
  const KNOWN: readonly LayerBlendMode[] = [
    'source-over', 'multiply', 'screen', 'overlay',
    'darken', 'lighten', 'color-dodge', 'color-burn',
    'hard-light', 'soft-light', 'difference', 'exclusion',
    'hue', 'saturation', 'color', 'luminosity',
  ];
  return KNOWN.includes(mode as LayerBlendMode) ? (mode as LayerBlendMode) : 'multiply';
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
    } else if (instance.category === 'shadow') {
      const params = instance.params as ShadowParams;
      stages.push({
        kind: 'shadow',
        color: toWorkingLinearRgba(params.color as ColorValue, workingSpace),
        offsetX: clampShadowOffset(params.offsetX),
        offsetY: clampShadowOffset(params.offsetY),
        blurRadius: clampShadowScalar(params.blurRadius, 0, 0, 100),
        spreadPx: params.spreadPx === undefined ? undefined : clampShadowScalar(params.spreadPx, 0, 0, 1000),
        opacity: clampShadowScalar(params.opacity, 1, 0, 1),
      });
    } else if (instance.category === 'colorOverlay') {
      // Optional-tolerant: documents written before the fields existed read
      // blendMode as Multiply and opacity as full strength.
      const params = instance.params as ColorOverlayParams;
      stages.push({
        kind: 'color-overlay',
        color: toWorkingLinearRgba(params.color as ColorValue, workingSpace),
        blendMode: sanitizeOverlayBlendMode(params.blendMode),
        opacity: params.opacity === undefined ? 1 : clampShadowScalar(params.opacity, 1, 0, 1),
      });
    } else if (instance.category === 'outerGlow') {
      // Optional-tolerant: absent spreadPx reads 0, absent strength reads 1.
      // The UI's blur/spread ranges are 0..50 — clamped here so a corrupted
      // document cannot explode the ROI window.
      const params = instance.params as OuterGlowParams;
      stages.push({
        kind: 'outer-glow',
        color: toWorkingLinearRgba(params.color as ColorValue, workingSpace),
        blurRadius: clampShadowScalar(params.blurRadius, 0, 0, 50),
        spreadPx: params.spreadPx === undefined ? undefined : clampShadowScalar(params.spreadPx, 0, 0, 50),
        strength: params.strength === undefined ? 1 : clampShadowScalar(params.strength, 1, 0, 1),
      });
    } else if (instance.category === 'gradientOverlay') {
      // Optional-tolerant: the non-color fields default to the reference
      // product's factory state (linear / 90deg / 100 scale / full opacity /
      // Normal blend). Scale keeps a sane positive range — a corrupted
      // document cannot explode or zero out the ramp extent.
      const params = instance.params as GradientOverlayParams;
      const style = params.style === 'radial' ? 'radial' : 'linear';
      stages.push({
        kind: 'gradient-overlay',
        colorStart: toWorkingLinearRgba(params.start as ColorValue, workingSpace),
        colorEnd: toWorkingLinearRgba(params.end as ColorValue, workingSpace),
        style,
        angleDeg: clampShadowScalar(params.angleDeg === undefined ? 90 : params.angleDeg, 90, 0, 360),
        scale: clampShadowScalar(params.scale === undefined ? 100 : params.scale, 100, 1, 1000),
        opacity: params.opacity === undefined ? 1 : clampShadowScalar(params.opacity, 1, 0, 1),
        blendMode: params.blendMode === undefined ? 'source-over' : sanitizeOverlayBlendMode(params.blendMode),
      });
    } else if (instance.category === 'innerGlow') {
      // Optional-tolerant: absent spreadPx reads 0, absent strength reads 1,
      // absent blendMode reads the reference factory default (Screen).
      const params = instance.params as InnerGlowParams;
      stages.push({
        kind: 'inner-glow',
        color: toWorkingLinearRgba(params.color as ColorValue, workingSpace),
        blurRadius: clampShadowScalar(params.blurRadius, 0, 0, 50),
        spreadPx: params.spreadPx === undefined ? undefined : clampShadowScalar(params.spreadPx, 0, 0, 50),
        strength: params.strength === undefined ? 1 : clampShadowScalar(params.strength, 1, 0, 1),
        blendMode: params.blendMode === undefined ? 'screen' : sanitizeOverlayBlendMode(params.blendMode),
      });
    } else if (instance.category === 'innerShadow') {
      // The OFFSET keeps its sign (a delta, like the outer shadow's) and
      // drops non-finites; magnitudes clamp to the UI ranges.
      const params = instance.params as InnerShadowParams;
      stages.push({
        kind: 'inner-shadow',
        color: toWorkingLinearRgba(params.color as ColorValue, workingSpace),
        offsetX: clampShadowOffset(params.offsetX),
        offsetY: clampShadowOffset(params.offsetY),
        blurRadius: clampShadowScalar(params.blurRadius, 0, 0, 50),
        spreadPx: params.spreadPx === undefined ? undefined : clampShadowScalar(params.spreadPx, 0, 0, 50),
        strength: params.strength === undefined ? 1 : clampShadowScalar(params.strength, 1, 0, 1),
        blendMode: params.blendMode === undefined ? 'multiply' : sanitizeOverlayBlendMode(params.blendMode),
      });
    }
  }
  return { effects: stages.length ? stages : undefined };
}
