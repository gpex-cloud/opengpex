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
 * antsPath.ts — PURE derivation + cache logic for the marching-ants SVG path.
 *
 * Extracted from `useFastSync.ts` so the cache rules (four-key invalidation +
 * integer-translation drag fast path + ss-mode simplification policy) are
 * unit-testable without React/ticker/DOM. The hook (`useSelectionAntsSync`)
 * only wires this module to the ticker and the DOM.
 */

import {
  asLocalPolygon, asLocalRect,
  LocalPolygon, LocalPoint, Point2D
} from '@opengpex/editor/core/types';
import { MARCHING_ANTS_MAX_VERTICES } from './protocols';

/** Display-edge mode (`deriveEdgeDisplayMode` on the geometry service). */
export type EdgeDisplayMode = 'ss' | 'aa' | 'na';

/**
 * Cached derived marching-ants SVG path.
 *
 * Cache invalidation keys:
 *   - `sourceRings` (reference equality): Detects when the polygon geometry changes.
 *     For regular tools (rect/ellipse), `regularShapeToLocalPolygon` always creates
 *     a new array → new reference → cache invalidates naturally.
 *     For irregular tools (lasso/wand), rings are the original user-drawn/algorithm-
 *     generated point set — they never change because the edge mode only affects
 *     display style, not the underlying geometry. toggleAntiAlias patches only the
 *     flags via shallow spread (`{ ...clipBox, antiAliased, ssdepMode }`), preserving
 *     the same rings ref.
 *
 *   - `mode` (value equality): Detects when the display-edge mode changes
 *     (`ss` smooth vs `aa`/`na` pixel staircase — see `deriveEdgeDisplayMode`).
 *     Without this key, toggling the mode on an irregular polygon would return a
 *     stale cached path — the ants wouldn't visually update until the tool is
 *     switched and switched back (which clears the cache).
 *
 *   - `gridOffsetKey`: The staircase is computed on the TARGET layer's pixel
 *     grid (its origin fraction in ring space, 0 or 0.5 — odd canvas dims shift
 *     it). A different active layer with a different grid phase must re-derive.
 *
 *   - `windowKey`: The visible-window quantization key (see `getVisibleRect`) —
 *     panning within a quantized block keeps the key stable → cache hit, no
 *     re-derivation; crossing a block boundary (or zooming) re-derives at
 *     O(visible arc).
 */
export interface AntsPathCache {
  /** Source polygon identity (reference equality check) */
  sourceRings: Point2D[][];
  /** Display-edge mode at time of caching (path changes between smooth/staired) */
  mode: EdgeDisplayMode;
  /** Grid phase key at time of caching (`${x}_${y}`) */
  gridOffsetKey: string;
  /** Visible-window quantization key at time of caching (or 'full') */
  windowKey: string;
  /** Derived SVG path `d` string */
  pathD: string;
}

/**
 * simplifyPolygonForAnts: Reduces polygon vertex count for marching ants display.
 *
 * ONLY used by the `ss` (smooth SSDEP display) mode — see the caller. The aa/na
 * staircase modes must consume the RAW rings: the staircase is the pixel-exact
 * boundary shared with the GPU fill-pass, and Douglas–Peucker would shift steps
 * away from the actually-cut pixels (plan §7.1 fact 3 / decision 2).
 *
 * Strategy:
 *   - If total vertex count ≤ ANTS_MAX_VERTICES, use the polygon as-is.
 *   - Otherwise, apply Douglas–Peucker with adaptive epsilon based on polygon
 *     bounding rect size. Iteratively doubles epsilon until total vertices
 *     fall below ANTS_MAX_VERTICES.
 *
 * The simplified polygon is ONLY used for SVG overlay display — the source data
 * in clipBoxes is never mutated, so cut/copy/mask operations remain pixel-precise.
 */
export function simplifyPolygonForAnts(
  poly: LocalPolygon,
  simplifyRingFn: (ring: Point2D[], epsilon: number) => Point2D[]
): LocalPolygon {
  // Count total vertices
  let totalVerts = 0;
  for (const ring of poly.rings) totalVerts += ring.length;

  // Below threshold: no simplification needed
  if (totalVerts <= MARCHING_ANTS_MAX_VERTICES) return poly;

  // Adaptive epsilon: start at 0.5% of the longer bounding dimension.
  // This is perceptually invisible at screen scale but eliminates redundant
  // micro-vertices from marching-squares / contour tracing outputs.
  const maxDim = Math.max(poly.rect.w, poly.rect.h);
  let epsilon = maxDim * 0.005;

  let simplified: Point2D[][] = poly.rings;
  let count = totalVerts;

  // Iterative reduction: double epsilon until within budget
  for (let attempt = 0; attempt < 6 && count > MARCHING_ANTS_MAX_VERTICES; attempt++) {
    simplified = poly.rings.map(ring => simplifyRingFn(ring, epsilon));
    count = 0;
    for (const ring of simplified) count += ring.length;
    epsilon *= 2;
  }

  // Safe cast: simplifyRing preserves the original LocalPoint objects (Douglas–Peucker
  // only drops vertices, never creates new ones), so the output is still LocalPoint[].
  return asLocalPolygon(simplified as unknown as LocalPoint[][], asLocalRect(poly.rect), poly.antiAliased, poly.ssdepMode === true);
}

/**
 * True when `b` is exactly `a` translated by the SAME integer (dx, dy) —
 * O(n) point-wise compare with a tiny epsilon (f64 addition of the delta can
 * round, so b−a must match dx within 1e-6 rather than exactly). Cheap
 * (≤ 0.1ms even for 10k-vertex wand rings) versus the O(H·k+P) scanline
 * re-derivation it avoids on every drag frame.
 */
export function isIntegerTranslation(a: Point2D[][], b: Point2D[][]): boolean {
  if (a.length !== b.length) return false;
  const dxRaw = b[0]?.[0]?.x - a[0]?.[0]?.x;
  const dyRaw = b[0]?.[0]?.y - a[0]?.[0]?.y;
  if (dxRaw === undefined || dyRaw === undefined) return false;
  const dx = Math.round(dxRaw);
  const dy = Math.round(dyRaw);
  // The delta must be integer (a translated staircase is only invariant under
  // integer shifts — a fractional shift changes the grid phase) and consistent.
  if (Math.abs(dxRaw - dx) > 1e-6 || Math.abs(dyRaw - dy) > 1e-6) return false;
  for (let r = 0; r < a.length; r++) {
    const ra = a[r];
    const rb = b[r];
    if (ra.length !== rb.length) return false;
    for (let i = 0; i < ra.length; i++) {
      if (Math.abs((rb[i].x - ra[i].x) - dxRaw) > 1e-6 ||
          Math.abs((rb[i].y - ra[i].y) - dyRaw) > 1e-6) {
        return false;
      }
    }
  }
  return true;
}

export interface AntsPathRequest {
  /** Current clip-box polygon (the selection's raw rings + mode flags). */
  entry: LocalPolygon;
  /** Resolved display-edge mode (`ss` / `aa` / `na`). */
  mode: EdgeDisplayMode;
  /** `${gridOffset.x}_${gridOffset.y}` — grid phase identity. */
  gridOffsetKey: string;
  /** Visible-window quantization key (or 'full' when uncapped / ss mode). */
  windowKey: string;
  /** Lazy full derivation (only invoked on a genuine cache miss). */
  derive: () => string;
}

/**
 * resolveAntsPath: cache-first derivation of the ants `d` string.
 *
 * Hit paths (in order):
 *   1. All four keys match AND the rings REFERENCE is unchanged → cached path.
 *   2. Keys match and the rings are an exact INTEGER translation of the cached
 *      ones (the move interaction recreates rings via `translatePolygon` every
 *      drag frame) → the rect-relative staircase is identical, reuse the cached
 *      `d` verbatim (the SVG group repositions via the rect selector).
 *   3. Otherwise run `derive()` and refresh the cache.
 */
export function resolveAntsPath(
  cache: AntsPathCache | null,
  req: AntsPathRequest,
): { pathD: string; cache: AntsPathCache } {
  const { entry, mode, gridOffsetKey, windowKey, derive } = req;

  if (cache && cache.mode === mode && cache.gridOffsetKey === gridOffsetKey && cache.windowKey === windowKey) {
    if (cache.sourceRings === entry.rings) return { pathD: cache.pathD, cache };
    if (isIntegerTranslation(cache.sourceRings, entry.rings)) {
      const next = { ...cache, sourceRings: entry.rings };
      return { pathD: next.pathD, cache: next };
    }
  }

  const pathD = derive();
  return { pathD, cache: { sourceRings: entry.rings, mode, gridOffsetKey, windowKey, pathD } };
}
