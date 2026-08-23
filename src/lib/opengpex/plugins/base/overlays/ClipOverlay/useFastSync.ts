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

import { useEffect, useRef } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync, useFastRectSync, useFastSvgGroupSync, useFastMarchingAntsSync, useFastAnchorSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { LocalShape, LocalPolygon, LocalPoint, asLocalShape, asLocalPolygon, asLocalRect, Point2D } from '@opengpex/editor/core/types';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import { ClipTool } from '../../options/ClipOptions/protocols';
import { MARCHING_ANTS_MAX_VERTICES } from './protocols';

const EMPTY_SHAPE: LocalShape = asLocalShape({ x: 0, y: 0, w: 0, h: 0 });

// ─── Marching Ants Path Simplification ─────────────────────────────────────────

/**
 * Cached simplified polygon for marching ants display.
 * Avoids re-running Douglas–Peucker on every tick when data hasn't changed.
 *
 * Cache invalidation keys:
 *   - `sourceRings` (reference equality): Detects when the polygon geometry changes.
 *     For regular tools (rect/ellipse), `regularShapeToLocalPolygon` always creates
 *     a new array → new reference → cache invalidates naturally.
 *     For irregular tools (lasso/wand), rings are the original user-drawn/algorithm-
 *     generated point set — they never change because AA only affects rendering style,
 *     not the underlying geometry. toggleAntiAlias patches only the `antiAliased` flag
 *     via shallow spread (`{ ...clipBox, antiAliased }`), preserving the same rings ref.
 *
 *   - `antiAliased` (value equality): Detects when the rendering style changes.
 *     The same rings produce different SVG paths depending on AA (smooth M/L/Z vs
 *     Bresenham staired H/V steps). Without this key, toggling AA on an irregular
 *     polygon would return stale cached path — the ants wouldn't visually update
 *     until the tool is switched and switched back (which clears the cache).
 */
interface AntsSimplifyCache {
  /** Source polygon identity (reference equality check) */
  sourceRings: Point2D[][];
  /** AA state at time of caching (path changes between smooth/staired) */
  antiAliased: boolean;
  /** Simplified SVG path `d` string */
  simplifiedD: string;
}

/**
 * simplifyPolygonForAnts: Reduces polygon vertex count for marching ants display.
 *
 * Strategy:
 *   - If total vertex count ≤ ANTS_VERTEX_THRESHOLD, use the polygon as-is.
 *   - Otherwise, apply Douglas–Peucker with adaptive epsilon based on polygon
 *     bounding rect size. Iteratively doubles epsilon until total vertices
 *     fall below ANTS_MAX_VERTICES.
 *
 * The simplified polygon is ONLY used for SVG overlay display — the source data
 * in clipBoxes is never mutated, so cut/copy/mask operations remain pixel-precise.
 */
function simplifyPolygonForAnts(
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
  return asLocalPolygon(simplified as unknown as LocalPoint[][], asLocalRect(poly.rect), poly.antiAliased);
}

/**
 * Resolve the regular clip shape for the CSS box (handles + dim label).
 * Returns EMPTY_SHAPE when the slot is empty.
 */
function resolveRegularClip(
  f: { clipBoxes: Record<string, unknown>; canvasClipBox: LocalShape },
  isReCanvas: boolean
): LocalShape {
  if (isReCanvas) return f.canvasClipBox;
  const poly = getRegularClipShape(f as { clipBoxes: Record<string, LocalPolygon> });
  if (!poly) return EMPTY_SHAPE;
  // Convert LocalPolygon to LocalShape for CSS box positioning
  const { rect, antiAliased } = poly;
  return { type: 'rect', rect, hardEdge: false, antiAliased, __brand: 'local' } as LocalShape;
}

// ─── useCropDimSync ────────────────────────────────────────────────────────────

/**
 * Fast-track hook for the dimension label (e.g. "400 × 300 px").
 * Only meaningful for regular shapes and Re-Canvas.
 */
export function useCropDimSync(isActive: boolean, isReCanvas: boolean) {
  const dimLabelRef = useRef<HTMLSpanElement>(null);

  useFastSync(dimLabelRef, isActive, (_v, f) => {
    const shape = resolveRegularClip(f, isReCanvas);
    const rect = shape.rect;
    if (dimLabelRef.current) {
      dimLabelRef.current.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
    }
  });

  return { dimLabelRef };
}

// ─── useRegularBoxSync ─────────────────────────────────────────────────────────

/**
 * CSS box positioning + visibility + rule-of-thirds guides.
 *
 * Active when the tool is regular (rect/ellipse) OR Re-Canvas. Drives the
 * draggable HTMLDivElement with resize handles. Reads only LocalShape data
 * (polygons in the slot produce EMPTY_SHAPE → box hidden via visibility gate).
 */
export function useRegularBoxSync(
  ref: React.RefObject<HTMLElement | null>,
  isActive: boolean,
  isReCanvas: boolean,
  showGridThreshold: number | null
) {
  const { geometry } = useEditorServices();
  const guidesRef = useRef<HTMLDivElement>(null);

  // Box position (fast-track CSS left/top/width/height)
  useFastRectSync(ref, isActive, {
    selector: (_v, f) => resolveRegularClip(f, isReCanvas).rect,
    space: 'local'
  });

  // Visibility gate: hide when shape is empty (0×0)
  useFastSync(ref, isActive, (_v, f) => {
    const shape = resolveRegularClip(f, isReCanvas);
    const rect = shape.rect;
    const isEmpty = rect.w <= 0 || rect.h <= 0;
    if (ref.current) {
      (ref.current as HTMLElement).style.visibility = isEmpty ? 'hidden' : '';
    }
  });

  // Rule-of-thirds: hide when zoom exceeds pixel grid threshold
  useFastSync(guidesRef, isActive, (_v, f, cam) => {
    if (guidesRef.current) {
      const k = geometry.getScale(f, cam);
      if (showGridThreshold !== null && k >= showGridThreshold) {
        guidesRef.current.style.opacity = '0';
      } else {
        guidesRef.current.style.opacity = '0.2';
      }
    }
  });

  // Cleanup: hide box + guides when deactivated
  useEffect(() => {
    if (isActive) {
      if (ref.current) (ref.current as HTMLElement).style.display = '';
      if (guidesRef.current) guidesRef.current.style.display = '';
    } else {
      if (ref.current) (ref.current as HTMLElement).style.display = 'none';
      if (guidesRef.current) {
        guidesRef.current.style.display = 'none';
        guidesRef.current.style.opacity = '0';
      }
    }
  }, [isActive, ref, guidesRef]);

  return { guidesRef };
}

// ─── useSelectionAntsSync ──────────────────────────────────────────────────────

/**
 * UNIFIED marching ants renderer for all selection types.
 *
 * Architecture (2026-07-05 dual-path high-contrast):
 *
 * Uses a dual-path technique (industry standard from Photoshop/GIMP/Krita):
 *   - `pathBgRef`: black dashes offset by half-period (fills foreground gaps)
 *   - `pathRef`: white/red dashes (standard phase)
 *
 * Both paths share the same SVG `d` attribute. The phase offset ensures that
 * at every point along the selection border, either a black or white segment
 * is visible — providing maximum contrast against ANY background color
 * (light checkerboard, dark images, white edges, etc.).
 *
 * Renders ALL selection types:
 *   - Rect selections (4 points)
 *   - Ellipse selections (smooth arc)
 *   - Polygon selections (lasso / wand / inverted)
 *   - Re-Canvas (red rect, always a shape)
 *
 * Fill is dynamically switched: `fill="none"` for shapes, semi-transparent
 * evenodd fill for polygons (helps visualize inside/outside of complex paths).
 */
export function useSelectionAntsSync(
  groupRef: React.RefObject<SVGGElement | null>,
  pathBgRef: React.RefObject<SVGPathElement | null>,
  pathRef: React.RefObject<SVGPathElement | null>,
  isActive: boolean,
  isReCanvas: boolean,
  clipTool: string
) {
  const { geometry } = useEditorServices();

  // ─── [Perf A] Simplification cache ───────────────────────────────────────
  // Caches the simplified SVG path string keyed by source polygon rings reference.
  // Since polygon data is immutable (new reference = new data), reference equality
  // is a reliable and O(1) cache invalidation strategy.
  const antsCacheRef = useRef<AntsSimplifyCache | null>(null);

  // SVG group positioning (at bounding rect origin, frame-local space)
  useFastSvgGroupSync(groupRef, isActive, {
    selector: (_v, f) => {
      if (isReCanvas) return f.canvasClipBox.rect;
      const entry = f.clipBoxes[clipTool] as LocalPolygon | undefined;
      if (!entry) return null;
      return entry.rect.w > 0 ? entry.rect : null;
    },
    space: 'local'
  });

  // Shared selector for both paths (bg + fg share the same geometry).
  // [Perf A] Applies Douglas–Peucker simplification for complex polygons and
  // caches the result — avoids re-computing on every tick.
  const antsSelector = (_v: unknown, f: { clipBoxes: Record<string, unknown>; canvasClipBox: LocalShape }): LocalShape | string | null => {
    if (isReCanvas) return f.canvasClipBox;
    const entry = f.clipBoxes[clipTool] as LocalPolygon | undefined;
    if (!entry) return null;

    // Cache hit: same polygon rings reference AND same AA state → return cached SVG path string
    const cache = antsCacheRef.current;
    const entryAA = entry.antiAliased !== false;
    if (cache && cache.sourceRings === entry.rings && cache.antiAliased === entryAA) {
      return cache.simplifiedD;
    }

    // Cache miss: simplify if needed, then generate SVG path
    const simplified = simplifyPolygonForAnts(entry, geometry.polygon.simplifyRing);
    const d = geometry.polygon.polygonToSvgPathD(simplified);

    // Store in cache (include AA state for invalidation on toggle)
    antsCacheRef.current = { sourceRings: entry.rings, antiAliased: entryAA, simplifiedD: d };
    return d;
  };

  // Background path (black, offset phase) — fills the foreground gaps
  useFastMarchingAntsSync(pathBgRef, isActive, {
    selector: antsSelector,
    resetKey: clipTool,
  });

  // Foreground path (white/red, standard phase)
  useFastMarchingAntsSync(pathRef, isActive, {
    selector: antsSelector,
    resetKey: clipTool,
  });

  // Dynamic fill: semi-transparent evenodd fill for irregular polygons (lasso/wand),
  // none for rect/ellipse (4-point or 64-point polygon — visually clean without fill).
  useFastSync(pathRef, isActive, (_v, f) => {
    if (!pathRef.current) return;
    if (isReCanvas) {
      pathRef.current.setAttribute('fill', 'none');
      return;
    }
    const entry = f.clipBoxes[clipTool] as LocalPolygon | undefined;
    // Irregular polygon: rings.length > 1 or ring has many points (lasso/wand/AI)
    const isIrregular = entry && entry.rings.length > 0 && entry.rings[0].length > 64;
    pathRef.current.setAttribute('fill', isIrregular ? 'rgba(240, 230, 255, 0.06)' : 'none');
  });

  // Group visibility: hidden when no data
  useFastSync(groupRef, isActive, (_v, f) => {
    if (!groupRef.current) return;
    if (isReCanvas) {
      groupRef.current.style.visibility = '';
      return;
    }
    const entry = f.clipBoxes[clipTool] as LocalPolygon | undefined;
    const hasData = !!entry && entry.rect.w > 0;
    groupRef.current.style.visibility = hasData ? '' : 'hidden';
  });

  // Cleanup on deactivation: hide group, clear both paths
  useEffect(() => {
    if (isActive) {
      if (groupRef.current) groupRef.current.style.display = '';
    } else {
      if (groupRef.current) groupRef.current.style.display = 'none';
      if (pathBgRef.current) pathBgRef.current.setAttribute('d', '');
      if (pathRef.current) pathRef.current.setAttribute('d', '');
    }
  }, [isActive, groupRef, pathBgRef, pathRef]);
}

// ─── useMoveDeltaSync ──────────────────────────────────────────────────────────

/**
 * Fast-track hook for the move-delta label (e.g. "Δ 42, −18 px").
 *
 * Same pattern as `useCropDimSync`: on each Ticker frame, reads the current
 * clip box position from the merged frame data and computes the difference
 * from the drag-start position (stored in volatile transient by the move handler).
 *
 * Visible only during an active drag; hidden otherwise (transient is null → label hidden).
 */
export function useMoveDeltaSync(isActive: boolean, clipTool: ClipTool) {
  const deltaContainerRef = useRef<HTMLDivElement>(null);
  const { volatileRef } = useEditorServices();

  // ─── Position: anchor to selection's bottom-left corner (local space) ───
  useFastAnchorSync(deltaContainerRef, isActive, {
    selector: (_v, f) => {
      // Only position when a drag is active (transient has start data)
      const start = volatileRef.current.transient['clipMoveStart'] as { x: number; y: number } | undefined;
      if (!start) return null;

      const entry = f.clipBoxes[clipTool] as LocalPolygon | undefined;
      if (!entry) return null;

      // Anchor at bottom-left of the selection bounding rect
      return { x: entry.rect.x, y: entry.rect.y + entry.rect.h };
    },
    offset: { x: 0, y: 24 }, // below dimension label (6px for dim + ~18px gap)
    space: 'local',
  });

  // ─── Content: compute and display dx/dy text + visibility ───
  useFastSync(deltaContainerRef, isActive, (_v, f) => {
    const el = deltaContainerRef.current;
    if (!el) return;

    const start = volatileRef.current.transient['clipMoveStart'] as { x: number; y: number } | undefined;
    if (!start) {
      el.style.display = 'none';
      return;
    }

    const entry = f.clipBoxes[clipTool] as LocalPolygon | undefined;
    if (!entry) {
      el.style.display = 'none';
      return;
    }

    const dx = Math.round(entry.rect.x - start.x);
    const dy = Math.round(entry.rect.y - start.y);

    // Format with directional arrows + absolute values (no negatives)
    // When displacement is 0, show "→ 0  ↓ 0" to indicate drag is active
    const hArrow = dx >= 0 ? '→' : '←';
    const vArrow = dy >= 0 ? '↓' : '↑';

    const span = el.firstElementChild as HTMLSpanElement;
    if (span) span.textContent = `${hArrow} ${Math.abs(dx)}  ${vArrow} ${Math.abs(dy)}`;
    el.style.display = '';
  });

  return { deltaContainerRef };
}
