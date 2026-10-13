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
 * curves/geometry.ts — pure geometry & point algebra for CurvesPanel.
 *
 * React-free by design: coordinate mapping, hit-testing, point constraints
 * and the spline preview path live here so they stay unit-testable without a
 * renderer, and `index.tsx` stays an interaction/render orchestrator.
 */

import type { CurvePoints, CurvesState } from "@opengpex/editor/core/types/models";
import { generateCurveLUT } from "@opengpex/editor/core/engine/color";
import { clamp01 } from "../helpers";
import { IDENTITY_CURVE_POINTS } from "../../protocols";

// ─── Graph geometry ────────────────────────────────────────────────────────────

/**
 * SVG viewBox: 256×192 (4:3) — PS-like proportions that cost ~25% less drawer
 * height than a square graph. X stays 1:1 with the 256 histogram bins; the
 * CSS `aspect-[4/3]` matches this ratio, so the render scale is UNIFORM and
 * control-point circles / strokes stay round (a square viewBox squeezed into
 * a shorter box via preserveAspectRatio="none" would ellipse them).
 */
export const VB_W = 256;
export const VB_H = 192;

/**
 * Number of samples along the preview path. 64 keeps the SVG small and easy
 * to diff in devtools while still producing a visually smooth curve — the
 * eye can't distinguish >32 segments on a 256px-wide canvas.
 */
export const PREVIEW_SAMPLES = 64;

/**
 * Radius (in viewBox units) around a control point where a pointerdown counts
 * as "grabbed this point" rather than "add a new point somewhere else". At
 * VB_W=256 this is ~4% of the width, comfortable for touch.
 */
export const HIT_RADIUS_VB = 10;

// ─── Point algebra ─────────────────────────────────────────────────────────────

/**
 * Read the current points for `channel`, defaulting to a fresh copy of the
 * identity segment. We hand back a COPY because the caller often needs to
 * mutate the result before writing back through `updateChannelCurve`.
 */
export function readPointsFor(
  curves: CurvesState | undefined,
  channel: keyof CurvesState,
): CurvePoints {
  const existing = curves?.[channel];
  if (existing && existing.length >= 2) {
    return existing.map((p) => [p[0], p[1]] as [number, number]);
  }
  return IDENTITY_CURVE_POINTS.map((p) => [p[0], p[1]] as [number, number]);
}

/**
 * Convert an SVG coordinate to a normalized (x, y) in [0, 1]. Y is inverted
 * because SVG's origin is top-left, but the curve editor's origin is
 * bottom-left (higher y = brighter output — standard tone-curve convention).
 */
export function svgToNormalized(vx: number, vy: number): [number, number] {
  return [clamp01(vx / VB_W), clamp01(1 - vy / VB_H)];
}

export function normalizedToSvg(x: number, y: number): [number, number] {
  return [x * VB_W, (1 - y) * VB_H];
}

/**
 * Distance² between a point and (px, py) in viewBox space. We compare
 * squared distance to avoid a `Math.sqrt` inside the hit-test loop.
 */
export function dist2(x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return dx * dx + dy * dy;
}

/**
 * Locate a control-point index within `HIT_RADIUS_VB` of (vx, vy).
 * Returns -1 when no point is close enough to grab.
 */
export function findHitIndex(pts: CurvePoints, vx: number, vy: number): number {
  const r2 = HIT_RADIUS_VB * HIT_RADIUS_VB;
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [sx, sy] = normalizedToSvg(pts[i][0], pts[i][1]);
    const d = dist2(sx, sy, vx, vy);
    if (d < r2 && d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Build the SVG polyline `d` attribute from a set of control points. We
 * sample the same `generateCurveLUT` used by the runtime so the preview and
 * the actual filter apply share ONE spline evaluator.
 */
export function curveToPathD(pts: CurvePoints): string {
  // `generateCurveLUT` at N samples gives us the y-values for xs = 0/(N-1),
  // 1/(N-1), …, 1. We convert those to SVG (with y inverted).
  const lut = generateCurveLUT(pts, 256 as const, "f32") as Float32Array;
  // Down-sample to PREVIEW_SAMPLES points for a compact SVG path.
  const step = (lut.length - 1) / (PREVIEW_SAMPLES - 1);
  const parts: string[] = [];
  for (let i = 0; i < PREVIEW_SAMPLES; i++) {
    const li = Math.round(i * step);
    const x = li / (lut.length - 1);
    const y = lut[li];
    const [sx, sy] = normalizedToSvg(x, y);
    parts.push(`${i === 0 ? "M" : "L"}${sx.toFixed(2)},${sy.toFixed(2)}`);
  }
  return parts.join(" ");
}

/**
 * Constrain the new x of a dragged/typed point so it can't jump past its
 * neighbors — this keeps the point list strictly x-sorted and matches the
 * "monotonic domain" invariant `normalizeControlPoints` (in luts.ts) enforces
 * anyway. Endpoints (i=0 and i=n-1) stay pinned at x=0 / x=1 (their `nx` is
 * ignored), which is also what makes typed In values on endpoints a no-op.
 */
export function movePointConstrained(
  pts: CurvePoints,
  index: number,
  nx: number,
  ny: number,
): CurvePoints {
  const next = pts.map((p) => [p[0], p[1]] as [number, number]);
  const clampedY = clamp01(ny);
  if (index === 0) {
    next[0] = [0, clampedY];
    return next;
  }
  if (index === next.length - 1) {
    next[next.length - 1] = [1, clampedY];
    return next;
  }
  // Interior: leave a tiny gap so points can't sit exactly on each other's x.
  const eps = 1 / VB_W; // ~0.4%: enough to keep the sort strict.
  const leftX = next[index - 1][0] + eps;
  const rightX = next[index + 1][0] - eps;
  const clampedX = Math.max(leftX, Math.min(rightX, clamp01(nx)));
  next[index] = [clampedX, clampedY];
  return next;
}

/**
 * Mirrors `insertPointSorted` in `commands.ts` — kept locally so the panel
 * can predict WHERE in the array the new point will land WITHOUT waiting for
 * a re-render. The command is still the source of truth (it writes to the
 * layer store); this function just computes the index we'll target during
 * the drag that immediately follows a click-to-add.
 *
 * If `commands.ts::insertPointSorted` ever changes shape, this helper must
 * change too. Both are covered by the vitest suite so a drift would surface
 * immediately.
 */
export function insertLocalPreview(
  points: CurvePoints,
  x: number,
  y: number,
): { pts: CurvePoints; index: number } {
  const cx = clamp01(x);
  const cy = clamp01(y);
  const next: CurvePoints = [];
  let inserted = false;
  let insertedAt = -1;
  for (const p of points) {
    if (!inserted && p[0] > cx) {
      insertedAt = next.length;
      next.push([cx, cy]);
      inserted = true;
    }
    if (p[0] === cx) continue;
    next.push([p[0], p[1]]);
  }
  if (!inserted) {
    insertedAt = next.length;
    next.push([cx, cy]);
  }
  return { pts: next, index: insertedAt };
}
