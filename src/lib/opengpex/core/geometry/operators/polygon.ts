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

import {
  Point2D,
  Layer, Frame,
  LocalPoint, WorldPoint,
  LocalRect, LocalPolygon, WorldPolygon,
  LocalShape, WorldShape,
  asLocalPoint, asWorldPoint,
  asLocalRect, asWorldRect,
  asLocalPolygon, asWorldPolygon,
} from '@opengpex/editor/core/types';
import { getLayerWorldMatrix } from './transform';
import { isLayerSource } from './utils';
// GridOffset / GridWindow / getVisibleRect / visibleGridWindow live in
// `./camera` (viewport-culling infrastructure): the staircase consumes the
// visible grid-cell window produced there, on the target layer's pixel grid.
import type { GridOffset, GridWindow } from './camera';
import { computePolygonBounds, point2dToLocalShape, ringsToPathData } from './point2d';

// computePolygonBounds re-exported from point2d.ts for backward compatibility
export { computePolygonBounds } from './point2d';

/**
 * localToWorldPolygon: Project polygon from local space to world space.
 *
 * Branching mirrors `shape.ts::localToWorldShape`:
 *   - Layer source: apply per-point through `getLayerWorldMatrix`
 *   - Frame source: translate by (-canvas.w/2, -canvas.h/2)
 */
export function localToWorldPolygon(poly: LocalPolygon, source: Layer | Frame): WorldPolygon {
  let worldRings: WorldPoint[][];

  if (isLayerSource(source)) {
    const wm = getLayerWorldMatrix(source);
    worldRings = poly.rings.map(ring => ring.map(p => {
      const wx = (p.x * wm.a) + (p.y * wm.c) + wm.tx;
      const wy = (p.x * wm.b) + (p.y * wm.d) + wm.ty;
      return asWorldPoint({ x: wx, y: wy });
    }));
  } else {
    const f = source;
    const dx = -f.canvas.w / 2;
    const dy = -f.canvas.h / 2;
    worldRings = poly.rings.map(ring => ring.map(p => asWorldPoint({ x: p.x + dx, y: p.y + dy })));
  }

  const worldBounds = asWorldRect(computePolygonBounds(worldRings));
  return asWorldPolygon(worldRings, worldBounds, poly.antiAliased, poly.ssdepMode === true);
}

/**
 * worldToLocalPolygon: Project polygon from world space to local space.
 *
 * Branching mirrors `shape.ts::worldToLocalShape`:
 *   - Layer target: apply inverse of `getLayerWorldMatrix` per point
 *   - Frame target: translate by (+canvas.w/2, +canvas.h/2)
 */
export function worldToLocalPolygon(poly: WorldPolygon, target: Layer | Frame): LocalPolygon {
  let localRings: LocalPoint[][];

  if (isLayerSource(target)) {
    // getLayerWorldMatrix returns a concrete Matrix3x3 instance (see transform.ts return type),
    // which exposes .inverse() directly. Mirrors space.ts::getLayerLocalAABB usage.
    const inv = getLayerWorldMatrix(target).inverse();
    localRings = poly.rings.map(ring => ring.map(p => {
      const out = inv.apply({ x: p.x, y: p.y });
      return asLocalPoint(out);
    }));
  } else {
    const f = target;
    const dx = f.canvas.w / 2;
    const dy = f.canvas.h / 2;
    localRings = poly.rings.map(ring => ring.map(p => asLocalPoint({ x: p.x + dx, y: p.y + dy })));
  }

  const localBounds = asLocalRect(computePolygonBounds(localRings));
  return asLocalPolygon(localRings, localBounds, poly.antiAliased, poly.ssdepMode === true);
}

/**
 * frameLocalToLayerLocal: Project polygon under artboard space (Frame) to layer (Layer) local space.
 * Composition: localToWorldPolygon(frame) -> worldToLocalPolygon(layer).
 *
 * Mirrors `shape.ts::frameLocalToLayerLocal`.
 */
export function frameLocalToLayerLocal(poly: LocalPolygon, frame: Frame, layer: Layer): LocalPolygon {
  const world = localToWorldPolygon(poly, frame);
  return worldToLocalPolygon(world, layer);
}

/**
 * layerLocalToFrameLocal: Inverse of `frameLocalToLayerLocal`.
 * Composition: localToWorldPolygon(layer) -> worldToLocalPolygon(frame).
 *
 * Mirrors `shape.ts::layerLocalToFrameLocal`. Used by the magic-wand handler
 * to project Worker-produced layer-local rings back into frame-local polygon
 * space before writing `irregularCropBox`.
 */
export function layerLocalToFrameLocal(poly: LocalPolygon, layer: Layer, frame: Frame): LocalPolygon {
  const world = localToWorldPolygon(poly, layer);
  return worldToLocalPolygon(world, frame);
}

// ─────────────────────────── Polygon Translation ───────────────────────────────

/**
 * translatePolygon: Translate all rings in a LocalPolygon by (dx, dy).
 *
 * Returns a new LocalPolygon with:
 *   - Every point in every ring offset by (dx, dy)
 *   - Bounding rect translated by (dx, dy) (width/height unchanged)
 *   - antiAliased flag preserved
 *
 * Used by the unified selection-move handler to reposition any polygon
 * selection (lasso / wand / AI matting) without recreating it.
 */
export function translatePolygon(poly: LocalPolygon, dx: number, dy: number): LocalPolygon {
  const newRings = poly.rings.map(ring =>
    ring.map(p => asLocalPoint({ x: p.x + dx, y: p.y + dy }))
  );
  const newRect = asLocalRect({
    x: poly.rect.x + dx,
    y: poly.rect.y + dy,
    w: poly.rect.w,
    h: poly.rect.h,
  });
  return asLocalPolygon(newRings, newRect, poly.antiAliased, poly.ssdepMode === true);
}

// ─────────────────────────── Polygon Utility Algorithms ────────────────────────

/**
 * isPointInPolygon: Determines whether a point lies inside a multi-ring polygon
 * using the ray-casting (even-odd) algorithm.
 *
 * Works with the evenodd fill rule: a point is "inside" if the total number of
 * ring boundary crossings (by a horizontal ray to +∞) is odd.
 *
 * @param point  The test point.
 * @param rings  Array of closed rings (each ring is an array of Point2D vertices).
 * @returns `true` if the point is inside the polygon (evenodd sense).
 */
export function isPointInPolygon(point: Point2D, rings: Point2D[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i].x, yi = ring[i].y;
      const xj = ring[j].x, yj = ring[j].y;
      const intersect = ((yi > point.y) !== (yj > point.y))
        && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
  }
  return inside;
}

/**
 * computeRingArea: Calculates the unsigned area of a single closed ring using the
 * Shoelace formula (Gauss's area formula).
 *
 * Returns the absolute value so callers don't need to worry about winding direction.
 *
 * @param ring  Array of vertices forming a closed polygon ring.
 * @returns Absolute area in square units of the coordinate system.
 */
export function computeRingArea(ring: Point2D[]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return Math.abs(area) / 2;
}

/**
 * simplifyOpen: Iterative Douglas–Peucker simplification for an OPEN polyline.
 *
 * Returns a simplified copy of `points`, keeping only vertices whose perpendicular
 * distance to the active line segment exceeds `epsilon`.
 *
 * @param points  Open polyline vertices (first and last are always retained).
 * @param epsilon Distance threshold — vertices closer than this to the simplified
 *                line are dropped. Must be > 0; if ≤ 0 returns a copy of the input.
 * @returns New array containing the simplified vertices.
 */
export function simplifyOpen(points: Point2D[], epsilon: number): Point2D[] {
  const n = points.length;
  if (n < 3 || epsilon <= 0) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  // Stack of [start, end] index pairs.
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const e = stack.pop() as number;
    const s = stack.pop() as number;
    if (e <= s + 1) continue;

    const ax = points[s].x, ay = points[s].y;
    const bx = points[e].x, by = points[e].y;
    const dx = bx - ax, dy = by - ay;
    const segLen2 = dx * dx + dy * dy;

    let maxD2 = -1;
    let maxIdx = -1;
    for (let i = s + 1; i < e; i++) {
      const px = points[i].x, py = points[i].y;
      let d2: number;
      if (segLen2 === 0) {
        const ex = px - ax, ey = py - ay;
        d2 = ex * ex + ey * ey;
      } else {
        // Perpendicular distance squared from p to line (a, b).
        const cross = (dx * (ay - py) - (ax - px) * dy);
        d2 = (cross * cross) / segLen2;
      }
      if (d2 > maxD2) { maxD2 = d2; maxIdx = i; }
    }

    if (maxIdx >= 0 && maxD2 > epsilon * epsilon) {
      keep[maxIdx] = 1;
      stack.push(s, maxIdx, maxIdx, e);
    }
  }

  const out: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i]);
  }
  return out;
}

/**
 * simplifyRing: Douglas–Peucker simplification for a CLOSED polygon ring.
 *
 * Appends a copy of the first vertex, runs the open-polyline simplification,
 * then removes the trailing duplicate before returning.
 *
 * @param ring    Closed ring vertices (no duplicated start/end vertex expected).
 * @param epsilon Distance threshold (same semantics as `simplifyOpen`).
 * @returns Simplified ring. Guaranteed to have ≥ 3 vertices if the input did,
 *          unless epsilon is extremely large.
 */
export function simplifyRing(ring: Point2D[], epsilon: number): Point2D[] {
  if (ring.length < 4 || epsilon <= 0) return ring.slice();
  const closed = ring.slice();
  closed.push(ring[0]);
  const simplified = simplifyOpen(closed, epsilon);
  if (simplified.length > 1 &&
    simplified[0].x === simplified[simplified.length - 1].x &&
    simplified[0].y === simplified[simplified.length - 1].y) {
    simplified.pop();
  }
  return simplified;
}

// ─────────────────────────── SVG Path Generation ───────────────────────────────

/**
 * Display-edge mode derivation (three-state model, see `Shape.ssdepMode`):
 *   - `ss`: SSDEP display mode — smooth geometric ants (viewport magic; the
 *     smooth path is kept but NOT wired to any backend rendering in P1).
 *   - `aa`: document-space AA on — GPU bakes a 1-document-px coverage ramp
 *     (`vmask.ts` formula B); ants are the pixel staircase.
 *   - `na`: AA off — GPU bakes a 1-bit binary edge; ants are the SAME pixel
 *     staircase (Photoshop model: the ants show the hard boundary regardless
 *     of AA; AA only decides whether half-transparent transition pixels are
 *     added on top of it).
 *
 * Normalization (read-side): `antiAliased === false && ssdepMode === true`
 * reads as `na` — the `ssdepMode ⇒ antiAliased` invariant repairs itself here.
 */
export type EdgeDisplayMode = 'ss' | 'aa' | 'na';

export function deriveEdgeDisplayMode(antiAliased?: boolean, ssdepMode?: boolean): EdgeDisplayMode {
  const aa = antiAliased !== false;
  const ss = ssdepMode === true && aa;
  return ss ? 'ss' : (aa ? 'aa' : 'na');
}

// ───────────────────────────────────────────────────────────────────────────────
// SHARED CPU/GPU PIXEL-CENTER RULE (the single rule document — vmask.ts must
// stay in lockstep; alignment is enforced by the staircase unit tests plus the
// manual GPU readback log comparison, no automated GPU readback):
//
// A grid pixel (x, y) — spanning ring space [gx+x, gx+x+1] × [gy+y, gy+y+1] —
// BELONGS to the selection iff its CENTER sample
//     (xc, yc) = (gx + x + 0.5 + 1/64,  gy + y + 0.5 + 1/128)
// satisfies the EVEN-ODD rule, using the exact same edge test as `vmask.ts`:
//   • vertical straddle (half-open): an edge counts iff
//     `(a.y > yc) != (b.y > yc)` — i.e. it covers yc ∈ [ymin, ymax);
//   • horizontal strictness: the crossing counts iff `xc < x_cross`
//     (interior intervals come out left-inclusive / right-exclusive);
//   • NO Math.round anywhere — crossings are used as floats.
// The +1/64 / +1/128 sample offsets are the TIE-BREAK, applied on BOTH sides
// (this CPU staircase AND the vmask.ts GPU fill-pass — same constants, exact
// in f32): GPU vertices are f32, CPU vertices are f64, and wand/DP output
// keeps integer vertices whose 45° edges pass EXACTLY through pixel centers.
// Without the shared nudge the two sides disagree on individual boundary
// pixels (a crossing landing between the two sample points flips one side).
// The offsets are > the f32 error at document coords ≤ 8192 (~1e-3), so CPU
// and GPU break every tie identically. The offsets apply ONLY to the
// inside/outside test — never to `d_signed` or the AA coverage formula
// (`clamp(0.5 - d, 0, 1)`).
//
// Consequence (formula B consistency): `coverage ≥ 0.5 ⇔ d_signed ≤ 0 ⇔ pixel
// center inside`, so the AA-ON mask thresholded at 50% equals the AA-OFF mask,
// and ONE staircase serves both modes.
// ───────────────────────────────────────────────────────────────────────────────

/** Even-odd sample offsets (see the shared rule document above). */
const CENTER_OFFSET_X = 1 / 64;
const CENTER_OFFSET_Y = 1 / 128;

/**
 * polygonToSvgPathD: Generate a multi-ring SVG path `d` string with evenodd fill rule.
 *
 * Output is RELATIVE to `poly.rect.x/y` (subtracted), so the resulting `d` is meant to be
 * placed inside an SVG <g> whose transform translates by (rect.x, rect.y). This matches
 * the existing `getSmoothSvgPath(LocalShape)` convention (which also outputs from origin (0,0)).
 *
 * Routing by the display-edge mode (`deriveEdgeDisplayMode`):
 *   - `ss` (SSDEP display, P2-reserved): Linear `M/L/Z` — connects float
 *     vertices directly (smooth geometry ants).
 *   - `aa` / `na`: pixel-staircase `M/H/V/Z` produced by the scanline
 *     staircase (`polygonToStairedPathD`) — IDENTICAL output for both modes
 *     (the ants show the hard boundary; AA only affects GPU-rendered
 *     transition pixels). `gridOffset` must be the target layer's origin
 *     fraction for the ants to coincide with the GPU-cut pixels.
 */
export function polygonToSvgPathD(
  poly: LocalPolygon,
  gridOffset: GridOffset = { x: 0, y: 0 },
  window?: GridWindow,
): string {
  if (!poly.rings.length) return '';

  const mode = deriveEdgeDisplayMode(poly.antiAliased, poly.ssdepMode);
  if (mode !== 'ss') {
    return polygonToStairedPathD(poly, gridOffset, window);
  }

  const ox = poly.rect.x;
  const oy = poly.rect.y;

  const parts: string[] = [];
  for (const ring of poly.rings) {
    if (ring.length < 2) continue;
    const segs: string[] = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const x = p.x - ox;
      const y = p.y - oy;
      segs.push(`${i === 0 ? 'M' : 'L'} ${x} ${y}`);
    }
    segs.push('Z');
    parts.push(segs.join(' '));
  }

  return parts.join(' ');
}

/**
 * polygonToShape: Convert a Polygon into an equivalent Shape descriptor.
 * This bridges the polygon type system into the vectorMask / clip pipeline.
 *
 * (Moved here from `helpers/path2d.ts` — it is a pure Polygon → Shape transform
 * with no DOM/Canvas dependency, so it belongs in the geometry engine alongside
 * `polygonToSvgPathD`.)
 *
 * Unlike `polygonToSvgPathD` (which outputs bounds-relative coordinates for SVG
 * overlay use), this function generates ABSOLUTE coordinates suitable for direct
 * `new Path2D(pathData)` consumption.
 *
 * Shape recognition (P5 — selection_layer_unification_spec §3.2):
 *   - 4-point axis-aligned ring → `type:'rect'` (preserves rendering precision)
 *   - 64-point ellipse approximation ring → `type:'circle'` (preserves rendering precision)
 *   - All other polygons → `type:'path'` with smooth M/L/Z pathData
 *
 * AA routing: pathData is ALWAYS written as smooth M/L/Z; the `antiAliased` flag
 * is preserved on the output shape as the single hard-edge signal for the GPU
 * pipeline (`SceneAssembler` → `VectorSubMask.hard` / vmask `flags` bit1). This
 * ensures `polygonToShape` is a pure serialization step with no rendering-time
 * decisions baked in.
 *
 * Overloaded: LocalPolygon → LocalShape, WorldPolygon → WorldShape.
 */
export function polygonToShape(poly: LocalPolygon): LocalShape;
export function polygonToShape(poly: WorldPolygon): WorldShape;
export function polygonToShape(poly: LocalPolygon | WorldPolygon): LocalShape | WorldShape {
  const antiAliased = poly.antiAliased !== false;

  // ── P5: Shape recognition ──────────────────────────────────────────────────
  // Only attempt recognition for single-ring polygons (multi-ring = complex shape).
  // `point2dToLocalShape` is typed for LocalPolygon rings (LocalPoint[][]) but the
  // underlying algorithm only uses x/y coordinates, so casting is safe here.
  if (poly.rings.length === 1) {
    const recognized = point2dToLocalShape(
      poly.rings as unknown as { x: number; y: number }[][],
      antiAliased
    );
    if (recognized) {
      // Preserve brand from the source polygon.
      return { ...recognized, __brand: poly.__brand } as LocalShape | WorldShape;
    }
  }

  // ── Irregular polygon: serialize to smooth M/L/Z pathData ─────────────────
  // pathData is ALWAYS smooth (no pre-baked stair-stepping) — AA routing is a
  // GPU-side decision via the antiAliased flag. Reuses the canonical
  // `ringsToPathData` serializer (drops degenerate <3-point rings).
  const pathD = poly.rings.length
    ? ringsToPathData(poly.rings as unknown as Point2D[][])
    : '';

  return {
    type: 'path' as const,
    rect: poly.rect,
    antiAliased,
    pathData: pathD,
    __brand: poly.__brand,
  } as LocalShape | WorldShape;
}

/**
 * polygonToStairedPathD: Scanline pixel-staircase path (the ants' hard boundary).
 *
 * Implements the SHARED CPU/GPU PIXEL-CENTER RULE documented above
 * `polygonToSvgPathD` — the same rule `vmask.ts` evaluates on the GPU — so the
 * staircase ants and the GPU-cut pixels coincide exactly (no 1px offset).
 * Replaces the v2 Bresenham vertex-stroke: stroking rounded VERTICES and
 * FILLING pixel CENTERS are different operations and disagree by 1px at slope
 * corners; here the region is derived from the fill rule itself.
 *
 * Algorithm (O(H·k + P), H = rows, k = crossings/row, P = staircase perimeter —
 * no per-pixel iteration, no Worker needed):
 *   1. Scanline: per row y, sample yc = gy + y + 0.5 + 1/128 through an active
 *      edge table (edges sorted by ymin; horizontal edges never straddle), pair
 *      the sorted crossings (even-odd), and emit the covered pixel-column runs
 *      via the strict center test (see `centerRunBounds`).
 *   2. Contour: emit the region's directed boundary edges (top/bottom via the
 *      per-row run difference, left/right verticals per run) and stitch them
 *      into closed rectilinear loops, preferring the RIGHT turn at the
 *      checkerboard vertex (diagonal pixel touch) so the two components split
 *      cleanly.
 *   3. Emit each loop as `M` + `H`/`V` runs + `Z`, relative to `poly.rect.x/y`.
 *
 * With `window` the derivation is viewport-culled: only cells inside the
 * window participate (see {@link GridWindow}), so the path — and every
 * re-rasterization of it (pan/zoom transform changes, dash-animation frames) —
 * costs O(visible arc) instead of O(full perimeter × device zoom).
 */
function polygonToStairedPathD(poly: LocalPolygon, gridOffset: GridOffset, window?: GridWindow): string {
  const runs = scanlinePixelRuns(poly.rings, gridOffset.x, gridOffset.y, window);
  if (runs.size === 0) return '';

  const loops = traceStaircaseLoops(runs);
  // Loops are traced in grid-INDEX space (runs hold column/row indices); map
  // them back onto the target layer's grid before making them rect-relative.
  const placed = loops.map((loop) => loop.map(([x, y]) => [x + gridOffset.x, y + gridOffset.y] as [number, number]));
  return loopsToPathD(placed, poly.rect.x, poly.rect.y);
}

/** One scanline edge: active for sample yc ∈ [ymin, ymax); never horizontal. */
interface ScanEdge {
  ymin: number;
  ymax: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * Step 1 — per-row covered pixel-column runs on the (gx, gy) grid, per the
 * shared rule. Returns `Map<row, Array<[kmin, kmax]>>` with sorted, disjoint,
 * ascending runs (rows may be sparse).
 */
function scanlinePixelRuns(
  rings: Point2D[][],
  gx: number,
  gy: number,
  window?: GridWindow,
): Map<number, Array<[number, number]>> {
  const edges: ScanEdge[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue; // degenerate ring has no area — same rule as the GPU packer
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      if (a.y === b.y) continue; // horizontal edges never straddle a scanline
      const ymin = Math.min(a.y, b.y);
      const ymax = Math.max(a.y, b.y);
      edges.push({ ymin, ymax, ax: a.x, ay: a.y, bx: b.x, by: b.y });
      if (ymin < minY) minY = ymin;
      if (ymax > maxY) maxY = ymax;
    }
  }
  const runs = new Map<number, Array<[number, number]>>();
  if (edges.length === 0) return runs;
  edges.sort((e1, e2) => e1.ymin - e2.ymin);

  // Row y has sample yc = gy + y + 0.5 + OFF_Y ∈ [minY, maxY) (half-open — an
  // edge straddles [ymin, ymax), mirroring `(a.y > yc) != (b.y > yc)`).
  let rowStart = Math.ceil(minY - gy - 0.5 - CENTER_OFFSET_Y);
  let rowEnd = Math.ceil(maxY - gy - 0.5 - CENTER_OFFSET_Y) - 1;
  // Viewport culling: rows outside the window produce no runs (their cells are
  // "uncovered" — contours close along the window edges).
  if (window) {
    rowStart = Math.max(rowStart, window.r0);
    rowEnd = Math.min(rowEnd, window.r1);
    if (rowStart > rowEnd) return runs;
  }

  const active: ScanEdge[] = [];
  let next = 0;
  for (let row = rowStart; row <= rowEnd; row++) {
    const yc = gy + row + 0.5 + CENTER_OFFSET_Y;
    while (next < edges.length && edges[next].ymin <= yc) active.push(edges[next++]);
    // In-place compaction: drop edges whose half-open span ended at/before yc.
    let w = 0;
    for (let r = 0; r < active.length; r++) {
      if (active[r].ymax > yc) active[w++] = active[r];
    }
    active.length = w;
    if (active.length < 2) continue;

    // Crossings, computed exactly like the GPU: t = (yc - a.y)/(b.y - a.y);
    // x_cross = a.x + t * (b.x - a.x).
    const xs: number[] = [];
    for (const e of active) {
      const t = (yc - e.ay) / (e.by - e.ay);
      xs.push(e.ax + t * (e.bx - e.ax));
    }
    xs.sort((a, b) => a - b);

    // Even-odd pairing: interior intervals are (xs[0], xs[1]), (xs[2], xs[3])…
    const rowRuns: Array<[number, number]> = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const bounds = centerRunBounds(xs[i], xs[i + 1], gx);
      if (!bounds) continue;
      if (window) {
        // Clamp columns to the window: cells beyond it count as uncovered, so
        // the staircase terminates against the window edges.
        const l = Math.max(bounds[0], window.k0);
        const r = Math.min(bounds[1], window.k1);
        if (l <= r) rowRuns.push([l, r]);
      } else {
        rowRuns.push(bounds);
      }
    }
    if (rowRuns.length > 0) runs.set(row, rowRuns);
  }
  return runs;
}

/**
 * Pixel columns k whose center sample gx + k + 0.5 + OFF_X lies STRICTLY inside
 * (xa, xb) — the TS twin of the GPU's `p.x < x_cross` counting. Equivalent to
 * the idealized `k ∈ [⌈xa-0.5⌉, ⌈xb-0.5⌉-1]` with the tie-break offsets folded
 * in (no `Math.round`: a center exactly ON a crossing is outside, deterministically).
 */
function centerRunBounds(xa: number, xb: number, gx: number): [number, number] | null {
  const kmin = Math.floor(xa - gx - 0.5 - CENTER_OFFSET_X) + 1;
  const kmax = Math.ceil(xb - gx - 0.5 - CENTER_OFFSET_X) - 1;
  return kmin <= kmax ? [kmin, kmax] : null;
}

/** Maximal sub-intervals of `runs` NOT covered by `minus` (both sorted, disjoint). */
function subtractRuns(
  runs: Array<[number, number]>,
  minus: Array<[number, number]> | undefined,
): Array<[number, number]> {
  if (!minus || minus.length === 0) return runs.slice();
  const out: Array<[number, number]> = [];
  let mi = 0;
  for (const [l, r] of runs) {
    while (mi < minus.length && minus[mi][1] < l) mi++;
    let cl = l;
    let m = mi;
    while (m < minus.length && minus[m][0] <= r && cl <= r) {
      const [ml, mr] = minus[m];
      if (ml > cl) out.push([cl, Math.min(ml - 1, r)]);
      cl = Math.max(cl, mr + 1);
      m++;
    }
    if (cl <= r) out.push([cl, r]);
  }
  return out;
}

/**
 * Step 2 — stitch the region's directed boundary edges into closed rectilinear
 * loops. Edges are directed so the interior stays on the RIGHT of travel
 * (clockwise outer contours in y-down screen coords; holes come out
 * counterclockwise — irrelevant under evenodd). At a checkerboard vertex (two
 * diagonal pixels touching, 2 outgoing edges) the RIGHT turn keeps the loop on
 * the same component, splitting diagonal touches into separate clean loops.
 */
function traceStaircaseLoops(
  runs: Map<number, Array<[number, number]>>,
): Array<Array<[number, number]>> {
  interface Edge { dx: number; dy: number; ex: number; ey: number }
  const edges = new Map<string, Edge[]>();
  const vkey = (x: number, y: number) => `${x},${y}`;
  const addEdge = (x: number, y: number, ex: number, ey: number): void => {
    const k = vkey(x, y);
    const list = edges.get(k);
    const e = { dx: Math.sign(ex - x), dy: Math.sign(ey - y), ex, ey };
    if (list) list.push(e);
    else edges.set(k, [e]);
  };

  for (const [y, rowRuns] of runs) {
    const prev = runs.get(y - 1);
    const next = runs.get(y + 1);
    for (const [l, r] of rowRuns) {
      // Left/right verticals are ALWAYS exposed (runs in a row are disjoint
      // with ≥1 uncovered column between them).
      addEdge(l, y + 1, l, y); // north (interior east)
      addEdge(r + 1, y, r + 1, y + 1); // south (interior west)
    }
    for (const [l, r] of subtractRuns(rowRuns, prev)) {
      addEdge(l, y, r + 1, y); // top, east (interior south)
    }
    for (const [l, r] of subtractRuns(rowRuns, next)) {
      addEdge(r + 1, y + 1, l, y + 1); // bottom, west (interior north)
    }
  }

  const loops: Array<Array<[number, number]>> = [];
  const rightTurn = (dx: number, dy: number): { dx: number; dy: number } => ({ dx: -dy, dy: dx });

  for (;;) {
    // Pick any unconsumed edge to start a new loop.
    let startKey: string | null = null;
    for (const k of edges.keys()) {
      if ((edges.get(k)?.length ?? 0) > 0) {
        startKey = k;
        break;
      }
    }
    if (startKey === null) break;

    const [sx, sy] = startKey.split(',').map(Number);
    const verts: Array<[number, number]> = [[sx, sy]];
    let cur = edges.get(startKey)!.pop()!;
    if (edges.get(startKey)!.length === 0) edges.delete(startKey);
    let px = cur.ex;
    let py = cur.ey;
    let dir = { dx: cur.dx, dy: cur.dy };
    verts.push([px, py]);

    // Follow the pairing (each incoming edge's outgoing is the right turn when
    // ambiguous) until the cycle closes at its start vertex. Each directed edge
    // is consumed exactly once, so this terminates.
    while (px !== sx || py !== sy) {
      const k = vkey(px, py);
      const cands = edges.get(k);
      if (!cands || cands.length === 0) break; // defensive: malformed region
      let idx = 0;
      if (cands.length > 1) {
        const rd = rightTurn(dir.dx, dir.dy);
        const found = cands.findIndex((c) => c.dx === rd.dx && c.dy === rd.dy);
        if (found >= 0) idx = found;
      }
      cur = cands.splice(idx, 1)[0];
      if (cands.length === 0) edges.delete(k);
      dir = { dx: cur.dx, dy: cur.dy };
      px = cur.ex;
      py = cur.ey;
      verts.push([px, py]);
    }
    loops.push(verts);
  }
  return loops;
}

/**
 * Step 3 — emit loops as an evenodd-fillable `M`/`H`/`V`/`Z` path, relative to
 * (ox, oy). Consecutive edges in a loop necessarily alternate H/V (a top edge's
 * only continuations are verticals), so no collinear merging is needed.
 */
function loopsToPathD(
  loops: Array<Array<[number, number]>>,
  ox: number,
  oy: number,
): string {
  const parts: string[] = [];
  for (const verts of loops) {
    const segs: string[] = [`M ${verts[0][0] - ox} ${verts[0][1] - oy}`];
    for (let i = 1; i < verts.length; i++) {
      const [_ax, ay] = verts[i - 1];
      const [bx, by] = verts[i];
      segs.push(ay === by ? `H ${bx - ox}` : `V ${by - oy}`);
    }
    segs.push('Z');
    parts.push(segs.join(' '));
  }
  return parts.join(' ');
}

// ─────────────────────────── Ellipse Path Polygon ──────────────────────────────

/**
 * ellipsePathToLocalPolygon: 360-point path-based ellipse polygon.
 *
 * Unlike `ellipseToLocalPolygon` (fixed 64 points, round-trips to type:'circle'),
 * this produces a 360-point polygon that feeds into `polygonToShape` → `type:'path'`
 * and uses the path rendering pipeline for pixel-perfect fragment/hole complementarity.
 *
 * Used by the PathEllipse selection tool to avoid the "clipped ellipse deformation"
 * problem that occurs when a circle-typed selection is intersected with a layer
 * (circle shapes have no pathData, preventing path ∩ path geometric intersection).
 *
 * 360 points never trigger the 64-point circle recognition in `point2dToLocalShape`.
 */
export function ellipsePathToLocalPolygon(rect: LocalRect, antiAliased: boolean = true): LocalPolygon {
  const { x, y, w, h } = rect;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const N = 360;

  const ring: LocalPoint[] = [];
  for (let i = 0; i < N; i++) {
    const theta = (2 * Math.PI * i) / N;
    ring.push({ x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta) } as LocalPoint);
  }

  return asLocalPolygon([ring], asLocalRect({ x, y, w, h }), antiAliased);
}

// Re-export point2d functions for backward compatibility (consumers may still
// import from polygon.ts). Canonical source is now point2d.ts.
export { isBoundingRing, point2dToLocalShape, point2dToLocalPolygon, invertRings } from './point2d';
