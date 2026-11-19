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
 * polygon-family/geometry.ts — the polygon-family marker family (star / polygon)'s (star / polygon) ENTIRE
 * render-side geometry. Both kinds share ONE engine primitive (`star`: a
 * regular radial polygon with n tips whose sharpness m sweeps the valley
 * radius; m = 2 is exactly the regular n-gon) and therefore share this one
 * vertex source, one SVG preview builder and one SDF translation — nothing
 * family-private may live in the cross-family `shapes/shared.ts`. Pure — no
 * React (checked by render-purity.test.ts).
 */

import type { MarkerBounding, MarkerData, SdfGeometry, StarMarkerData } from '../../types';
import { toCssColor4 } from '@opengpex/editor/core/engine/color';
import { svgFillAttrs, svgStroke } from '../shared';
import { sdfSolverOutline } from '@opengpex/editor/core/engine/pipeline/scene/sdfPolygonSolver';
import type { SdfSolverOutline } from '@opengpex/editor/core/engine/pipeline/scene/sdfPolygonSolver';

/**
 * Sharpness that makes the star polygon TRUE: valleys land exactly on the
 * chords between alternate tips, so every star edge is one straight line and
 * the inner hole's edges are parallel to the outer chords — the classic
 * {n/2} star polygon. Closed form: collinearity forces the valley radius to
 * r·cos(2π/n)/cos(π/n), and equating that with the valley formula
 * r·(cos(π/n) − sin(π/n)/tan(π/m)) solves to m = 2n/(n−2)
 * (n=5 → 10/3, valley ratio exactly cos(72°)/cos(36°) = 0.382 — the classic
 * pentagram). This is the marker tool's ONLY star shape: shapes must be
 * canonical, not tunable.
 */
export function starTrueSharpness(points: number): number {
  const n = Math.max(4, Math.round(points));
  return (2 * n) / (n - 2);
}

/** Effective sharpness of a star datum: the stored legacy value, or the derived true star. */
export function starEffectiveSharpness(data: StarMarkerData): number {
  return data.sharpness ?? starTrueSharpness(data.points);
}

/**
 * Inner-vertex radius of the regular star as a fraction of the outer radius,
 * derived from the same (points, sharpness) parametrisation the GPU SDF uses:
 * the spike edge leaves the tip at angle π/sharpness and meets the sector
 * boundary (angle π/points from the tip) at the inner vertex. Sharpness 2 gives
 * cos(π/n) — the edge midpoint of a regular polygon; sharpness n gives 0.
 */
export function starInnerRadiusRatio(points: number, sharpness: number): number {
  const n = Math.max(3, Math.round(points));
  const m = Math.min(Math.max(sharpness, 2), n);
  const an = Math.PI / n;
  const en = Math.PI / m;
  return Math.max(0, Math.cos(an) - Math.sin(an) / Math.tan(en));
}

/**
 * Vertices of a regular n-gon / 2n-vertex star inscribed in the inset box, first
 * vertex pointing up (-y on screen) to match the GPU orientation. `inner` < 1
 * alternates outer/inner radii (star); `inner` undefined emits only the n outer
 * vertices (polygon).
 */
export function radialPolygonPoints(
  bounding: MarkerBounding,
  strokeWidth: number,
  n: number,
  inner?: number,
): string[] {
  const half = strokeWidth / 2;
  const w = Math.max(0, bounding.w - strokeWidth);
  const h = Math.max(0, bounding.h - strokeWidth);
  const cx = half + w / 2;
  const cy = half + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const count = inner === undefined ? n : n * 2;
  const step = inner === undefined ? (2 * Math.PI) / n : Math.PI / n;
  const pts: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = inner === undefined || i % 2 === 0 ? 1 : inner;
    const theta = -Math.PI / 2 + i * step;
    pts.push(`${cx + Math.cos(theta) * rx * r},${cy + Math.sin(theta) * ry * r}`);
  }
  return pts;
}


// ─── Content-filling ellipse (tight bounding) ─────────────────────────────────

/** Semi-axis multipliers + fractional centre offsets of the content-filling ellipse. */
export interface ContentFillEllipse {
  rxScale: number;
  ryScale: number;
  cxDelta: number;
  cyDelta: number;
}

/**
 * Ellipse that makes a regular n-gon (first vertex up) EXACTLY fill its box:
 * the n vertices' AABB after the shader's anisotropic mapping equals the box.
 * Closed form from the vertices' sin/cos extremes — the mapping p.x =
 * c.x + sinθ·semi.x (p.y = c.y − cosθ·semi.y) spans [0, w]×[0, h] iff
 * semi.x = w/(maxS−minS), c.x = −minS·semi.x, semi.y = h/(maxC−minC),
 * c.y = maxC·semi.y. n = 4 degenerates to the identity (1, 1, 0, 0) — the
 * diamond already fills its box — which doubles as the formula's sanity
 * anchor. Applies at EVERY sharpness: the tips' angular positions depend only
 * on n, so star and polygon share one table.
 */
export function contentFillEllipse(n: number): ContentFillEllipse {
  const sides = Math.max(3, Math.round(n));
  let minS = Infinity;
  let maxS = -Infinity;
  let minC = Infinity;
  let maxC = -Infinity;
  for (let k = 0; k < sides; k++) {
    const theta = (2 * Math.PI * k) / sides;
    const sv = Math.sin(theta);
    const cv = Math.cos(theta);
    if (sv < minS) minS = sv;
    if (sv > maxS) maxS = sv;
    if (cv < minC) minC = cv;
    if (cv > maxC) maxC = cv;
  }
  const rxScale = 2 / (maxS - minS);
  const ryScale = 2 / (maxC - minC);
  const cxDelta = (-minS) / (maxS - minS) - 0.5;
  const cyDelta = maxC / (maxC - minC) - 0.5;
  return { rxScale, ryScale, cxDelta, cyDelta };
}

/**
 * Natural bounding ratio of the REGULAR form: the sin/cos spans of the n tip
 * angles on the unit circle (first vertex up). A regular n-gon inscribed at
 * unit radius has exactly this AABB aspect, so it is the "squareize" target
 * for radial shapes — squaring the box would squash a triangle/pentagon away
 * from its regular proportions, not towards them. Both fill regimes share the
 * tip angular set (the inscribed legacy box and the content-fill ellipse both
 * map the SAME unit-circle vertices, anisotropically), so one closed-form
 * table covers legacy and content-fill markers, and stars too: the inner
 * valleys always sit inside the tips' AABB, so the silhouette aspect is the
 * tips' aspect. Returned un-normalized; callers only consume the RATIO.
 */
export function radialNaturalRatio(n: number): { w: number; h: number } {
  const sides = Math.max(3, Math.round(n));
  let minS = Infinity;
  let maxS = -Infinity;
  let minC = Infinity;
  let maxC = -Infinity;
  for (let k = 0; k < sides; k++) {
    const theta = (2 * Math.PI * k) / sides;
    const sv = Math.sin(theta);
    const cv = Math.cos(theta);
    if (sv < minS) minS = sv;
    if (sv > maxS) maxS = sv;
    if (cv < minC) minC = cv;
    if (cv > maxC) maxC = cv;
  }
  return { w: maxS - minS, h: maxC - minC };
}

/** 6-scalar star shapeParams for a content-fill marker ([n, m] + ellipse multipliers). */
function contentFillShapeParams(n: number, m: number): number[] {
  const e = contentFillEllipse(n);
  return [n, m, e.rxScale, e.ryScale, e.cxDelta, e.cyDelta];
}

/**
 * Stroke-ring SVG for a radial marker preview: the stroke ink drawn as an
 * EVENODD path (outer ring + stroke-inset inner ring) instead of a stroked
 * `<polygon>`. The rings come from the ENGINE'S OWN `sdfSolverOutline` — the
 * exact artifact the GPU consumes — so the preview is one-to-one with the
 * release render by construction: same vertices, same inset, same
 * degenerate/fallback thresholds (a second, plugin-local inset
 * implementation drifted in its validity checks and produced mid-drag mode
 * flips and evenodd centre artifacts). `inner` empty = solid shape (legacy
 * sharpness-2 polygon with a fully-swallowed inset); a stroked `<polygon>`
 * can never reproduce this ring: SVG miter JOINS fill into concave corners
 * while the solver keeps sharp inner corners.
 */
export function solverRingSvg(
  outline: SdfSolverOutline,
  color: string,
): string | null {
  const { outer, inner } = outline;
  if (outer.length < 6) return null;
  const subpath = (v: readonly number[]) => {
    let d = `M ${v[0]} ${v[1]}`;
    for (let i = 2; i < v.length; i += 2) d += ` L ${v[i]} ${v[i + 1]}`;
    return d + ' Z';
  };
  const d = subpath(outer) + (inner.length >= 6 ? ' ' + subpath(inner) : '');
  return `<path d="${d}" fill="${color}" fill-rule="evenodd" stroke="none" />`;
}

/**
 * SVG preview of a radial marker. Content-fill markers (bounding: true) draw
 * the engine's OWN solver outline as an evenodd ring — one-to-one with the
 * GPU render; legacy markers keep the classic stroked `<polygon>` (the old
 * pixels must not change).
 *
 * The degenerate guard (box inset by the stroke empty) gates the LEGACY branch
 * only. A content-fill box AT or BELOW the stroke width must still preview:
 * the erosion probe empties the hole and the solver ring renders the SOLID
 * shape — exactly what the GPU paints (interior = shape eroded by the full
 * stroke width = empty, stroke covers the whole shape). A blank preview there
 * diverges from a release render that visibly appears.
 */
export function radialToSvg(data: MarkerData, bounding: MarkerBounding): string {
  const sw = Math.max(0, data.stroke.width);
  if (data.kind === 'star' || data.kind === 'polygon') {
    if (data.bounding) {
      const sdf = radialToSdf(data);
      const outline = sdfSolverOutline(sdf.prim, [bounding.w, bounding.h], sw, sdf.shapeParams, 0);
      if (outline) {
        const ring = solverRingSvg(outline, svgStroke(data));
        // Fill UNDER the band (the GPU composites stroke OVER fill).
        if (ring) return fillOverlay(data, outline) + ring;
      }
    }
  }
  if (bounding.w - sw <= 0 || bounding.h - sw <= 0) return '';
  let pts: string[];
  if (data.kind === 'star') {
    const n = Math.max(3, Math.round(data.points));
    pts = radialPolygonPoints(bounding, sw, n, starInnerRadiusRatio(data.points, starEffectiveSharpness(data)));
  } else if (data.kind === 'polygon') {
    pts = radialPolygonPoints(bounding, sw, Math.max(3, Math.round(data.sides)));
  } else {
    return '';
  }
  return (
    `<polygon points="${pts.join(' ')}" ` +
    `${svgFillAttrs(data)} stroke="${svgStroke(data)}" stroke-width="${sw}" stroke-linejoin="miter" />`
  );
}

/**
 * Fill layer UNDER the solver ring: the WHOLE shape (the outer ring) filled
 * with the fill colour, mirroring the GPU's fill-under-band compose (the SVG
 * fill-then-stroke model). Filling only the eroded interior would
 * over-composite two complementary coverages along the shared inner boundary
 * and open a translucent seam between fill and stroke with AA on.
 */
export function fillOverlay(data: MarkerData, outline: SdfSolverOutline): string {
  const opacity = data.fill.opacity;
  if (!(opacity > 0)) return '';
  const pts: string[] = [];
  for (let i = 0; i < outline.outer.length; i += 2) {
    pts.push(`${outline.outer[i]},${outline.outer[i + 1]}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${toCssColor4(data.fill.color)}" fill-opacity="${opacity}" stroke="none" />`;
}

/**
 * Engine SDF translation for a radial marker. A regular n-gon IS the n-point
 * star at sharpness 2 (the polygon end of the sharpness range), so both kinds
 * speak the same engine primitive.
 */
export function radialToSdf(data: MarkerData): SdfGeometry {
  if (data.kind === 'star') {
    const n = Math.max(3, Math.round(data.points));
    const m = starEffectiveSharpness(data);
    return {
      prim: 'star',
      // Content-fill stamp → multipliers ride the params; zero-packed legacy
      // → the shader/solver normalize zeros back to the inscribed ellipse.
      shapeParams: data.bounding ? contentFillShapeParams(n, m) : [n, m],
    };
  }
  if (data.kind === 'polygon') {
    const n = Math.max(3, Math.round(data.sides));
    return {
      prim: 'star',
      shapeParams: data.bounding ? contentFillShapeParams(n, 2) : [n, 2],
    };
  }
  return { prim: 'star', shapeParams: [3, 2] };
}
