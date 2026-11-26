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
 * effectRoi.ts — Render-ROI expansion maths for layer effects (A8).
 *
 * An outward stroke pushes visible pixels BEYOND the content rect by the
 * dilation radius, so the effect prepass must render into a window that
 * contains `content ∪ dilated(content)`. This module owns that geometry as
 * PURE functions (unit/golden-testable, no GPU state):
 *
 *   • `expandWindowForStroke` — pad a rect outward by the stroke radius plus
 *     the AA slack, rounded outward per edge (a fractional content rect must
 *     never crop a coverage ramp landing on a boundary texel).
 *   • `strokeTransientSize` — the integer texel dims of that window at a
 *     given allocation density, clamped to the device's max texture dim
 *     (uniform shrink beats a failed creation — the same contract as the
 *     vector transient clamp).
 *
 * DELIBERATE NON-RELATIONSHIP: `core/geometry/margins.ts` is the AA-bleed
 * constant home (AA_MARGIN = 1, featherPad) for SOURCE-side padding; the
 * effect's outward reach is a direct function of the effect PARAMETER
 * (stroke radius), not an AA constant, so it is computed here and never
 * routes through margins.ts.
 *
 * @module core/gpu/graph/build/support/effectRoi
 */

import type { EffectStageDesc } from '../../../scene/Scene';

/**
 * Extra texels padded around the dilated contour so the shader's AA ramp and
 * the half-texel sample grid both land inside the window. The dilation is a
 * max-filter (exact integer support), so the ramp width is 1 texel; 2 gives
 * comfortable headroom without measurable cost.
 */
export const STROKE_ROI_AA_SLACK_PX = 2;

/** A rect in window units (logical px on the effect-transient contract). */
export interface EffectWindow {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Union of every EFFECT stage's outward reach for one layer, in logical px.
 * The max keeps the shape honest across stroke (placement-dependent reach)
 * and shadow (offset + blur reach) stages.
 */
export function effectReachPx(stages: readonly EffectStageDesc[] | undefined): number {
  const pads = effectWindowPadsPx(stages);
  return Math.max(pads.left, pads.top, pads.right, pads.bottom);
}

/**
 * Gaussian kernel half-width in logical px: `ceil(3σ)` clamped to 60 — the
 * SAME clamp the separable-Gaussian kernel applies (`gaussianKernelRadius`),
 * so the ROI never pads less than the blur can actually spread.
 */
export function shadowBlurReachPx(sigma: number): number {
  const s = Number.isFinite(sigma) && sigma > 0 ? sigma : 0;
  return Math.min(60, Math.ceil(3 * s));
}

/**
 * Per-edge outward reach of every EFFECT stage, in logical px. Stroke pads
 * uniformly; a shadow shifts its blurred silhouette by (offsetX, offsetY) and
 * spreads it `3σ` further on every side, so each edge pads
 * `blurReach + max(offsetComponent, 0)` — the blurred copy legitimately lands
 * beyond the content on the offset's positive side, and the blur halo leaks
 * `3σ` past it on BOTH sides of the shifted rect.
 */
export function effectWindowPadsPx(stages: readonly EffectStageDesc[] | undefined): {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
} {
  let left = 0;
  let top = 0;
  let right = 0;
  let bottom = 0;
  if (stages) {
    for (const s of stages) {
      if (s.kind === 'stroke') {
        const w = Number.isFinite(s.widthPx) && s.widthPx > 0 ? s.widthPx : 0;
        const outReach = s.position === 'inside' ? 0 : s.position === 'center' ? w * 0.5 : w;
        left = Math.max(left, outReach);
        top = Math.max(top, outReach);
        right = Math.max(right, outReach);
        bottom = Math.max(bottom, outReach);
      } else if (s.kind === 'shadow') {
        const ox = Number.isFinite(s.offsetX) ? s.offsetX : 0;
        const oy = Number.isFinite(s.offsetY) ? s.offsetY : 0;
        const blur = shadowBlurReachPx(s.blurRadius);
        // Positive spread dilates the silhouette before the blur — the halo
        // rides on the DILATED rect, so the pad grows by the spread (the
        // translator clamps it non-negative; PS's Spread has no erosion).
        const spreadRaw = s.spreadPx;
        const spread = typeof spreadRaw === 'number' && Number.isFinite(spreadRaw) ? spreadRaw : 0;
        left = Math.max(left, blur + spread + Math.max(-ox, 0));
        top = Math.max(top, blur + spread + Math.max(-oy, 0));
        right = Math.max(right, blur + spread + Math.max(ox, 0));
        bottom = Math.max(bottom, blur + spread + Math.max(oy, 0));
      } else if (s.kind === 'outer-glow') {
        // A glow is a zero-offset shadow: the halo spreads `3σ` past the
        // (optionally dilated) silhouette on EVERY side equally — no offset
        // asymmetry.
        const blur = shadowBlurReachPx(s.blurRadius);
        const spreadRaw = s.spreadPx;
        const spread = typeof spreadRaw === 'number' && Number.isFinite(spreadRaw) ? spreadRaw : 0;
        left = Math.max(left, blur + spread);
        top = Math.max(top, blur + spread);
        right = Math.max(right, blur + spread);
        bottom = Math.max(bottom, blur + spread);
      }
    }
  }
  return { left, top, right, bottom };
}

/**
 * Pad `base` into the effect render window with per-edge pads, rounded
 * OUTWARD (floor on the min side, ceil on the max side) so a fractional
 * content rect never clips a coverage ramp landing on a boundary texel. NOT
 * clamped to any source bounds — the effect transient is a fresh allocation
 * the prepass owns, and effect pixels legitimately land outside the content
 * rect (negative window origins are expected, mirroring the alphaFeather
 * `beyondSource` posture).
 */
export function expandWindowForPads(
  base: EffectWindow,
  pads: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
): EffectWindow {
  const x0 = Math.floor(base.x - pads.left - STROKE_ROI_AA_SLACK_PX);
  const y0 = Math.floor(base.y - pads.top - STROKE_ROI_AA_SLACK_PX);
  const x1 = Math.ceil(base.x + base.w + pads.right + STROKE_ROI_AA_SLACK_PX);
  const y1 = Math.ceil(base.y + base.h + pads.bottom + STROKE_ROI_AA_SLACK_PX);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Pad `base` outward into the effect render window: every edge moves out by
 * `reachPx + STROKE_ROI_AA_SLACK_PX`, rounded OUTWARD (floor on the min side,
 * ceil on the max side) so a fractional content rect never clips the ramp.
 * NOT clamped to any source bounds — the effect transient is a fresh
 * allocation the prepass owns, and a stroke ring legitimately lands outside
 * the content rect (negative window origins are expected, mirroring the
 * alphaFeather `beyondSource` posture).
 */
export function expandWindowForStroke(base: EffectWindow, reachPx: number): EffectWindow {
  const pad = (Number.isFinite(reachPx) && reachPx > 0 ? reachPx : 0) + STROKE_ROI_AA_SLACK_PX;
  const x0 = Math.floor(base.x - pad);
  const y0 = Math.floor(base.y - pad);
  const x1 = Math.ceil(base.x + base.w + pad);
  const y1 = Math.ceil(base.y + base.h + pad);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Texel dims of `window` at `density` texels per window unit, rounded outward,
 * uniformly shrunk (never below 1) to the device's max texture dimension —
 * the same "uniform shrink beats failed creation" contract as the vector
 * transient clamp.
 */
export function strokeTransientSize(
  window: EffectWindow,
  density: number,
  maxDimension: number,
): { readonly width: number; readonly height: number } {
  const d = Number.isFinite(density) && density > 0 ? density : 1;
  const cap = Math.max(1, Math.floor(maxDimension));
  const width = Math.min(cap, Math.max(1, Math.ceil(window.w * d)));
  const height = Math.min(cap, Math.max(1, Math.ceil(window.h * d)));
  return { width, height };
}

/**
 * The rect the stroke rings, in CONTENT-TEXTURE texels: the source-prep stage's
 * declared `contentRectInTexture`, or the full texture when the stage declared
 * nothing (content-aligned by definition). The effect prepass anchors its
 * window expansion on THIS and never re-derives the rect from `layer.crop`
 * semantics — a stale crop origin on a content-aligned trimmed asset therefore
 * cannot shift the ring off the pixels it is supposed to outline.
 */
export function strokeContentBase(
  contentRectInTexture: EffectWindow | undefined,
  textureWidth: number,
  textureHeight: number,
): EffectWindow {
  return contentRectInTexture ?? { x: 0, y: 0, w: textureWidth, h: textureHeight };
}

