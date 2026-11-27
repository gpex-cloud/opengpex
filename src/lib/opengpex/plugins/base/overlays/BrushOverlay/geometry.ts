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
 * geometry.ts — Pure geometry for the logic brush's commit-time box tightening.
 *
 * WHY IT EXISTS: while the pointer is down the stroke layer wears a
 * CANVAS-SIZED box (`cx = cy = 0`, trajectory in plain canvas coordinates) so
 * every new sample can just be appended — no box recomputation, no re-basing,
 * no visual jump mid-drag. On pointerup the layer is tightened to a snug box,
 * matching the legacy raster brush's persisted geometry (its bake step crops to
 * the dirty rect + 1px, clamped to the canvas), so a stroke layer behaves like
 * any other layer in the layers panel, in transforms and in export.
 *
 * INVARIANCE (the load-bearing property, unit-tested): re-basing the trajectory
 * into the tightened box must not move a single pixel on screen. A local point
 * `p` sits at world `cx - w/2 + p.x`; before tightening that is `p.x - W/2`,
 * and after it is `(x0 + w/2 - W/2) - w/2 + (p.x - x0)` = `p.x - W/2`. Identical
 * for any box, including a clamped one.
 *
 * Kept free of React / editor services on purpose: it is the one part of the
 * overlay worth a golden test.
 *
 * @module plugins/base/overlays/BrushOverlay/geometry
 */

import type { StrokePoint } from '@opengpex/editor/core/types';
import { TAPER_ARC_FRACTION } from './protocols';

/** An axis-aligned box in canvas coordinates. */
export interface StrokeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The tightened stroke: box-local trajectory + the layer geometry to write. */
export interface TightenedStroke {
  /** Trajectory re-based into the tightened box (layer-local logical pixels). */
  points: StrokePoint[];
  /** The tightened box in canvas coordinates (its w/h become `layer.bounding`). */
  box: StrokeBox;
  /** World-space centre of the box (`layer.cx`). */
  cx: number;
  /** World-space centre of the box (`layer.cy`). */
  cy: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Tighten a canvas-space trajectory into a snug, canvas-clamped layer box.
 *
 * @param points  Trajectory in CANVAS coordinates (the in-drag representation).
 * @param size    Tip diameter at pressure 1 (`StrokeData.size`, logical px).
 * @param canvas  Canvas extent; the box is clamped into it, exactly as the
 *                legacy brush's bake-time crop is.
 * @param clipRect  Optional additional clamp: the active selection's bounding
 *                box (canvas coordinates) inflated by 1px of AA margin. The
 *                box is clamped into the INTERSECTION of canvas and clipRect —
 *                coverage outside the selection is zero by the confinement
 *                multiply, so texels out there would be allocated for nothing.
 *                A stroke fully outside the selection collapses to a degenerate
 *                1px box on the selection edge and renders nothing (same
 *                posture as a fully off-canvas stroke).
 * @returns The re-based trajectory + layer geometry, or `null` for an empty
 *          trajectory (nothing to place).
 *
 * The raw bounding box inflates by `size / 2` (the ribbon's coverage radius)
 * and then resolves to the EXACT touched-texel bounds: texel centres sit on
 * half-integers, so a texel is touched (non-zero coverage, centre distance
 * ≤ radius, the test is inclusive) iff its centre ≥ minX − r — the touched
 * span is `ceil(minX − r − 0.5)` .. `floor(maxX + r + 0.5)`. A plain
 * floor/ceil on the radius bounds overshoots by one texel whenever the
 * radius edge's fractional part exceeds 0.5 (the probe-verified off-by-one:
 * declared 21×33 vs actual ink 20×32). Padding uses the full `size` rather
 * than the per-sample `size × pressure` so that a later pressure edit cannot
 * spill outside the box. What was removed (the legacy `+1px AA feather`
 * headroom) WAS slack beyond even the touched span.
 */
export function tightenStroke(
  points: readonly StrokePoint[],
  size: number,
  canvas: { w: number; h: number },
  clipRect?: { x: number; y: number; w: number; h: number },
): TightenedStroke | null {
  if (points.length === 0) return null;

  // Box extent: when a selection clip rect is given, measure it from the
  // parts of the trajectory that actually CROSS the rect — the raw trajectory
  // bbox would drag in the clipped-away tails (a diagonal stroke crossing the
  // selection corner-to-corner would keep the whole off-selection span as
  // permanently transparent box area). Per-SEGMENT Liang-Barsky clip against
  // the rect: segment-level, not point-level, because a sparse straight
  // crossing can have BOTH endpoint samples outside the selection while the
  // segment between them paints right through it. A lone point (no segments)
  // counts only when it is itself inside. The POINT STREAM is never trimmed —
  // this only decides the box; the coverage multiply clips the pixels.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  if (clipRect) {
    const rX0 = clipRect.x, rY0 = clipRect.y;
    const rX1 = clipRect.x + clipRect.w, rY1 = clipRect.y + clipRect.h;
    const grow = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    // Liang-Barsky: parametric clip of segment (a→b) against the rect.
    // Returns the visible sub-segment's endpoints, or null when it misses.
    const clipSegment = (ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax, dy = by - ay;
      let t0 = 0, t1 = 1;
      const p = [-dx, dx, -dy, dy];
      const q = [ax - rX0, rX1 - ax, ay - rY0, rY1 - ay];
      for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
          if (q[i] < 0) return null;
        } else {
          const r = q[i] / p[i];
          if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
          else { if (r < t0) return null; if (r < t1) t1 = r; }
        }
      }
      return { x0: ax + t0 * dx, y0: ay + t0 * dy, x1: ax + t1 * dx, y1: ay + t1 * dy };
    };
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      if (i + 1 < points.length) {
        const b = points[i + 1];
        const seg = clipSegment(a.x, a.y, b.x, b.y);
        if (seg) { grow(seg.x0, seg.y0); grow(seg.x1, seg.y1); }
      } else if (points.length === 1 && a.x >= rX0 && a.x <= rX1 && a.y >= rY0 && a.y <= rY1) {
        grow(a.x, a.y);
      }
    }
  } else {
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  if (clipRect && (minX === Infinity || maxX < minX || maxY < minY)) {
    // Nothing crosses the selection — collapse to a degenerate 1px box on the
    // nearest selection edge (same posture as off-canvas strokes).
    const cw0 = Math.max(1, canvas.w);
    const ch0 = Math.max(1, canvas.h);
    const loX = Math.max(0, clipRect.x);
    const loY = Math.max(0, clipRect.y);
    const hiX = Math.min(cw0, clipRect.x + clipRect.w);
    const hiY = Math.min(ch0, clipRect.y + clipRect.h);
    const cx = clamp(Math.floor(points[0].x), loX, hiX);
    const cy = clamp(Math.floor(points[0].y), loY, hiY);
    return {
      points: points.map((p) => ({ x: p.x - cx, y: p.y - cy, pressure: p.pressure, alpha: p.alpha })),
      box: { x: cx, y: cy, w: 1, h: 1 },
      cx: cx + 0.5 - cw0 / 2,
      cy: cy + 0.5 - ch0 / 2,
    };
  }

  const pad = Math.max(0, size) / 2;
  const cw = Math.max(1, canvas.w);
  const ch = Math.max(1, canvas.h);

  // Resolve the exact touched-texel bounds (see the JSDoc), then clamp into
  // the canvas ∩ (optional) selection bounding box. A stroke drawn entirely
  // outside either bound collapses to a degenerate 1px box on that edge — it
  // renders nothing, which is what a fully off-canvas (or fully
  // out-of-selection) stroke should do. The clip rect arrives pre-inflated by
  // its AA margin from the caller.
  const loX = clipRect ? Math.max(0, clipRect.x) : 0;
  const loY = clipRect ? Math.max(0, clipRect.y) : 0;
  const hiX = clipRect ? Math.min(cw, clipRect.x + clipRect.w) : cw;
  const hiY = clipRect ? Math.min(ch, clipRect.y + clipRect.h) : ch;
  const x0 = clamp(Math.ceil(minX - pad - 0.5), loX, hiX);
  const y0 = clamp(Math.ceil(minY - pad - 0.5), loY, hiY);
  const x1 = clamp(Math.floor(maxX + pad + 0.5), loX, hiX);
  const y1 = clamp(Math.floor(maxY + pad + 0.5), loY, hiY);

  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);

  return {
    points: points.map((p) => ({ x: p.x - x0, y: p.y - y0, pressure: p.pressure, alpha: p.alpha })),
    box: { x: x0, y: y0, w, h },
    // World origin is the canvas centre (see GeometryService.localToWorld).
    cx: x0 + w / 2 - cw / 2,
    cy: y0 + h / 2 - ch / 2,
  };
}

// ─── Stroke collection helpers (pure) ──────────────────────────────────────────

/**
 * Effective per-end taper zone lengths for a trajectory: each requested cap
 * (a multiple of the tip diameter scaled by that end's slider fraction) is
 * clamped to a fraction of the stroke's total arc length, so long strokes
 * grow long calligraphic tips while a fixed cap can never swallow a short
 * stroke. Head and tail are INDEPENDENT — either may be 0 (that end keeps
 * its round cap). Both the densifier and the envelope must be handed THESE
 * same clamped values — they locate the zones by arc distance and have to
 * agree on where each one ends.
 */
export function taperZones(
  points: readonly StrokePoint[],
  maxZonePerEnd: number,
  headFrac: number,
  tailFrac: number,
): { head: number; tail: number } {
  if (points.length < 2) return { head: 0, tail: 0 };
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  if (total <= 0) return { head: 0, tail: 0 };
  const clamp = (frac: number) =>
    frac > 0 ? Math.min(maxZonePerEnd * Math.min(1, frac), total * TAPER_ARC_FRACTION) : 0;
  return { head: clamp(headFrac), tail: clamp(tailFrac) };
}

/**
 * Insert interior samples along the trajectory so the taper envelope is
 * evaluated densely enough to survive the renderer's linear width
 * interpolation between samples.
 *
 * WHY IT EXISTS: trajectory samples land only every couple of canvas px of
 * rope travel, and a fast gesture can jump far more than that between pointer
 * events. A sparse stroke discretizes the taper ramp into a few long segments,
 * so the linear interpolation renders a blunt rounded tip even though the
 * envelope itself would end in a point — and the bluntness then depends on how
 * fast the stroke was drawn. Densifying ONLY the head/tail zone portions keeps
 * the added point count bounded by the zone length (zone / step per end,
 * regardless of stroke speed or total length) while the stroke body — which
 * carries no envelope — stays exactly as sampled.
 */
export function densifyTaperZones(
  points: readonly StrokePoint[],
  headZone: number,
  tailZone: number,
  step: number,
): StrokePoint[] {
  if ((headZone <= 0 && tailZone <= 0) || step <= 0 || points.length < 2) {
    return points as StrokePoint[];
  }

  const cum = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const total = cum[points.length - 1];
  if (total <= 0) return points as StrokePoint[];

  // Same capping as the envelope itself: a very short stroke tapers from both
  // ends into the middle, so each zone can never exceed half the arc.
  const head = Math.min(Math.max(0, headZone), total / 2);
  const tail = Math.min(Math.max(0, tailZone), total / 2);
  const segmentTouchesZone = (d0: number, d1: number) =>
    (head > 0 && (d0 < head || d1 < head)) ||
    (tail > 0 && (total - d0 < tail || total - d1 < tail));

  const out: StrokePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (segmentTouchesZone(cum[i - 1], cum[i])) {
      const segLen = cum[i] - cum[i - 1];
      const n = Math.max(1, Math.ceil(segLen / step));
      for (let j = 1; j < n; j++) {
        const t = j / n;
        const p: StrokePoint = {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          pressure: a.pressure + (b.pressure - a.pressure) * t,
        };
        if (a.alpha !== undefined && b.alpha !== undefined) {
          (p as { alpha?: number }).alpha = a.alpha + (b.alpha - a.alpha) * t;
        }
        out.push(p);
      }
    }
    out.push(b);
  }
  return out;
}

/**
 * Smooth calligraphic taper ramp over `[0, zone]`.
 * Keeps a `minTipRatio` floor at `d = 0` so the tip never vanishes completely
 * under the cursor, and supports asymmetric head/tail exponents. Shared by
 * `applyTaper` (commit-time envelope) and `IncrementalStrokeTrajectory`
 * (live preview) so both paths stay numerically identical by construction.
 */
export function taperEnvelope(
  d: number,
  zone: number,
  power = 2,
  minTipRatio = 0,
): number {
  if (zone <= 0 || d >= zone) return 1;
  const t = Math.max(0, d / zone);
  const s = Math.sin((t * Math.PI) / 2) ** power;
  return minTipRatio + (1 - minTipRatio) * s;
}

// Asymmetric calligraphic exponents: the entry ramp is slightly fuller (a
// fatter entry reads as a confident pen-down) while the exit is sharper (a
// quicker falloff reads as a lifted stroke). Both paths (commit + preview)
// MUST use the same pair.
const TAPER_HEAD_POWER = 1.6;
const TAPER_TAIL_POWER = 2.2;

/**
 * Append-taper envelope: multiply each sample's pressure by a smooth ramp
 * over the first `headZone` / last `tailZone` px of ARC LENGTH, independently
 * per end (a zone of 0 leaves that end's round cap untouched — "one end
 * sharp, one end round" calligraphy). This is how the taper brush preset
 * works — it WRITES pressure (the width lane is `size × pressure` and the
 * alpha lane can derive from it), so the shape survives re-render, undo
 * replay and export with no extra state.
 *
 * The ramp is a `sin^power` curve over the zone (at its minimum exactly at
 * the tip, tangent-flat where it meets the untouched body) — the classic
 * calligraphic entry/exit, with `minTipRatio` keeping a visible filament at
 * the very tip. Samples beyond the zones keep `pressure × 1`. Both zones <= 0
 * is the no-op.
 *
 * With `fadeAlpha` set (pressure-opacity dynamics on) the envelope multiplies
 * each sample's alpha by the same ramp: width alone narrows the tip but keeps
 * it at full ink density, which reads as a hard spike rather than a brush
 * lifting off — the ink must thin out WITH the geometry. Samples without an
 * alpha lane (pressure-opacity off) are untouched.
 */
export function applyTaper(
  points: readonly StrokePoint[],
  headZone: number,
  tailZone: number,
  fadeAlpha = false,
  minTipRatio = 0,
): StrokePoint[] {
  if ((headZone <= 0 && tailZone <= 0) || points.length < 2) return points as StrokePoint[];

  // Cumulative arc length; total span decides whether the head and tail zones
  // overlap (a very short stroke tapers from both ends into the middle).
  const cum = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const total = cum[points.length - 1];
  if (total <= 0) return points as StrokePoint[];

  const head = Math.min(Math.max(0, headZone), total / 2);
  const tail = Math.min(Math.max(0, tailZone), total / 2);

  return points.map((p, i) => {
    const fromStart = cum[i];
    const fromEnd = total - cum[i];
    const f = Math.min(
      taperEnvelope(fromStart, head, TAPER_HEAD_POWER, minTipRatio),
      taperEnvelope(fromEnd, tail, TAPER_TAIL_POWER, minTipRatio),
    );
    if (fadeAlpha && p.alpha !== undefined) {
      return { ...p, pressure: p.pressure * f, alpha: p.alpha * f };
    }
    return { ...p, pressure: p.pressure * f };
  });
}

/**
 * Rope-model stabilizer advance (Photoshop "smoothing" semantics): the rope
 * point chases the pointer but only moves the EXCESS beyond the slack radius,
 * so hand tremor inside the slack never enters the stroke at all.
 *
 * @param rope    current rope position (canvas px)
 * @param pointer raw pointer position (canvas px)
 * @param slack   slack radius in canvas px (the UI value is screen px, divided
 *                by camera zoom by the caller so the felt smoothness is
 *                zoom-independent)
 * @returns the advanced rope position; unchanged while the pointer stays
 *          inside the slack.
 */
export function advanceRope(
  rope: { x: number; y: number },
  pointer: { x: number; y: number },
  slack: number,
): { x: number; y: number } {
  if (slack <= 0) return { x: pointer.x, y: pointer.y };
  const dx = pointer.x - rope.x;
  const dy = pointer.y - rope.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= slack) return rope;
  const excess = (dist - slack) / dist;
  return { x: rope.x + dx * excess, y: rope.y + dy * excess };
}

/** Head/tail envelope factors for one arc position, using the shared curve. */
function taperFactors(
  arc: number,
  totalArc: number,
  head: number,
  tail: number,
  minTipRatio: number,
): number {
  return Math.min(
    taperEnvelope(arc, head, TAPER_HEAD_POWER, minTipRatio),
    taperEnvelope(totalArc - arc, tail, TAPER_TAIL_POWER, minTipRatio),
  );
}

/**
 * O(1)-per-move CPU trajectory accumulator for live brush previews.
 *
 * Separates the monotonically solidified prefix (whose head taper and arc
 * position are permanently frozen) from the bounded dynamic tail (whose tail
 * taper shrinks/slides as total arc grows), without touching GPU buffer layouts.
 */
export class IncrementalStrokeTrajectory {
  readonly rawPoints: StrokePoint[] = [];
  private readonly cumArc: number[] = [];
  private readonly combinedPoints: StrokePoint[] = [];

  private readonly headZone: number;
  private readonly maxTailZone: number;
  private readonly fadeAlpha: boolean;
  private readonly minSampleDist: number;
  private readonly minTipRatio: number;

  private solidifiedRawEnd = 0;
  private solidifiedOutCount = 0;

  constructor(
    headZone: number,
    maxTailZone: number,
    fadeAlpha: boolean,
    minSampleDist: number,
    minTipRatio = 0,
  ) {
    this.headZone = Math.max(0, headZone);
    this.maxTailZone = Math.max(0, maxTailZone);
    this.fadeAlpha = fadeAlpha;
    this.minSampleDist = minSampleDist;
    this.minTipRatio = minTipRatio;
  }

  get length(): number {
    return this.rawPoints.length;
  }

  get lastPoint(): StrokePoint | undefined {
    return this.rawPoints[this.rawPoints.length - 1];
  }

  /** Append a landed trajectory sample in O(1) and advance the solidified prefix. */
  push(p: StrokePoint): void {
    const n = this.rawPoints.length;
    if (n === 0) {
      this.rawPoints.push(p);
      this.cumArc.push(0);
      return;
    }
    const prev = this.rawPoints[n - 1];
    const segLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    this.rawPoints.push(p);
    this.cumArc.push(this.cumArc[n - 1] + segLen);
    this.advanceSolidified();
  }

  /**
   * Build the O(1) tapered StrokePoint array and solidified prefix count for
   * the current frame (optionally including a non-landed sub-threshold preview tail).
   */
  buildPointsView(previewTail?: StrokePoint): {
    readonly points: readonly StrokePoint[];
    readonly solidifiedCount: number;
  } {
    const n = this.rawPoints.length;
    if (n === 0) {
      return { points: [], solidifiedCount: 0 };
    }

    const lastRaw = this.rawPoints[n - 1];
    const extraArc = previewTail ? Math.hypot(previewTail.x - lastRaw.x, previewTail.y - lastRaw.y) : 0;
    const totalArc = this.cumArc[n - 1] + extraArc;

    // Zone capping MUST match the commit path's `taperZones` exactly (the same
    // requested zone clamped to TAPER_ARC_FRACTION of the total arc) — the
    // live preview is a promise about the stroke the release will commit, and
    // any clamp mismatch shows on screen as the tip reshaping at pointer-up.
    const head = totalArc > 0 ? Math.min(this.headZone, totalArc * TAPER_ARC_FRACTION) : 0;
    const tail = totalArc > 0 ? Math.min(this.maxTailZone, totalArc * TAPER_ARC_FRACTION) : 0;

    // Truncate dynamic tail from previous frame while keeping solidified prefix intact.
    this.combinedPoints.length = this.solidifiedOutCount;
    const startRaw = this.solidifiedRawEnd;

    if (this.solidifiedOutCount === 0) {
      const p0 = this.rawPoints[0];
      const f0 = totalArc > 0 ? taperFactors(0, totalArc, head, tail, this.minTipRatio) : 1;
      this.combinedPoints.push(this.applyFactor(p0, f0));
    }

    const tailCount = n - startRaw + (previewTail ? 1 : 0);
    for (let k = 1; k < tailCount; k++) {
      const isPreview = previewTail !== undefined && k === tailCount - 1;
      const a = this.rawPoints[startRaw + k - 1];
      const b = isPreview ? previewTail! : this.rawPoints[startRaw + k];
      const d0 = this.cumArc[startRaw + k - 1];
      const d1 = isPreview ? totalArc : this.cumArc[startRaw + k];

      const touchesTaper =
        totalArc > 0 &&
        ((head > 0 && (d0 < head || d1 < head)) ||
          (tail > 0 && (totalArc - d0 < tail || totalArc - d1 < tail)));

      if (touchesTaper) {
        const segLen = d1 - d0;
        const steps = Math.max(1, Math.ceil(segLen / this.minSampleDist));
        for (let j = 1; j < steps; j++) {
          const t = j / steps;
          const arc = d0 + segLen * t;
          const f = taperFactors(arc, totalArc, head, tail, this.minTipRatio);
          const interp: StrokePoint = {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            pressure: a.pressure + (b.pressure - a.pressure) * t,
            ...(a.alpha !== undefined && b.alpha !== undefined
              ? { alpha: a.alpha + (b.alpha - a.alpha) * t }
              : {}),
          };
          this.combinedPoints.push(this.applyFactor(interp, f));
        }
      }

      const f1 = totalArc > 0 ? taperFactors(d1, totalArc, head, tail, this.minTipRatio) : 1;
      this.combinedPoints.push(this.applyFactor(b, f1));
    }

    return {
      points: this.combinedPoints,
      solidifiedCount: this.solidifiedOutCount,
    };
  }

  private advanceSolidified(): void {
    const n = this.rawPoints.length;
    if (n < 2) return;

    const totalArc = this.cumArc[n - 1];
    // Wait until the arc clamp (TAPER_ARC_FRACTION of total) can no longer
    // shrink the head zone — head = min(headZone, totalArc × fraction) is
    // permanently frozen once totalArc × fraction >= headZone.
    if (this.headZone > 0 && totalArc * TAPER_ARC_FRACTION < this.headZone) return;

    const safeBoundaryArc = totalArc - this.maxTailZone;
    this.combinedPoints.length = this.solidifiedOutCount;

    while (this.solidifiedRawEnd + 1 < n && this.cumArc[this.solidifiedRawEnd + 1] <= safeBoundaryArc) {
      const i0 = this.solidifiedRawEnd;
      const i1 = i0 + 1;
      const a = this.rawPoints[i0];
      const b = this.rawPoints[i1];
      const d0 = this.cumArc[i0];
      const d1 = this.cumArc[i1];

      if (i0 === 0 && this.solidifiedOutCount === 0) {
        this.combinedPoints.push(this.applyFactor(a, taperEnvelope(0, this.headZone, TAPER_HEAD_POWER, this.minTipRatio)));
      }

      if (this.headZone > 0 && d0 < this.headZone) {
        const segLen = d1 - d0;
        const steps = Math.max(1, Math.ceil(segLen / this.minSampleDist));
        for (let j = 1; j < steps; j++) {
          const t = j / steps;
          const arc = d0 + segLen * t;
          const f = taperEnvelope(arc, this.headZone, TAPER_HEAD_POWER, this.minTipRatio);
          const interp: StrokePoint = {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            pressure: a.pressure + (b.pressure - a.pressure) * t,
            ...(a.alpha !== undefined && b.alpha !== undefined
              ? { alpha: a.alpha + (b.alpha - a.alpha) * t }
              : {}),
          };
          this.combinedPoints.push(this.applyFactor(interp, f));
        }
      }

      this.combinedPoints.push(this.applyFactor(b, taperEnvelope(d1, this.headZone, TAPER_HEAD_POWER, this.minTipRatio)));
      this.solidifiedOutCount = this.combinedPoints.length;
      this.solidifiedRawEnd = i1;
    }
  }

  private applyFactor(p: StrokePoint, factor: number): StrokePoint {
    if (factor === 1) return p;
    if (this.fadeAlpha && p.alpha !== undefined) {
      return { ...p, pressure: p.pressure * factor, alpha: p.alpha * factor };
    }
    return { ...p, pressure: p.pressure * factor };
  }
}
