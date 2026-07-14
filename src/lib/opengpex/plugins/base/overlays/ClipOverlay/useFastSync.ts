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
import { LocalShape, LocalPolygon, asLocalShape, isPolygon } from '@opengpex/editor/core/types';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import { ClipTool } from '../../options/ClipOptions/protocols';

const EMPTY_SHAPE: LocalShape = asLocalShape({ x: 0, y: 0, w: 0, h: 0 });

/**
 * Resolve the regular clip shape for the CSS box (handles + dim label).
 * Returns EMPTY_SHAPE when the slot is empty or contains a polygon.
 */
function resolveRegularClip(
  f: { clipBoxes: Record<string, unknown>; canvasCropBox: LocalShape },
  isReCanvas: boolean
): LocalShape {
  if (isReCanvas) return f.canvasCropBox;
  return getRegularClipShape(f as { clipBoxes: Record<string, LocalShape | LocalPolygon> }) || EMPTY_SHAPE;
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

  // Visibility gate: hide when shape is empty (0×0 or polygon in slot)
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
  cropTool: string
) {
  const { geometry } = useEditorServices();

  // SVG group positioning (at bounding rect origin, frame-local space)
  useFastSvgGroupSync(groupRef, isActive, {
    selector: (_v, f) => {
      if (isReCanvas) return f.canvasCropBox.rect;
      const entry = f.clipBoxes[cropTool];
      if (!entry) return null;
      if (isPolygon(entry)) return (entry as LocalPolygon).rect;
      const shape = entry as LocalShape;
      return (shape.rect.w > 0) ? shape.rect : null;
    },
    space: 'local'
  });

  // Shared selector for both paths (bg + fg share the same geometry)
  const antsSelector = (_v: unknown, f: { clipBoxes: Record<string, unknown>; canvasCropBox: LocalShape }): LocalShape | string | null => {
    if (isReCanvas) return f.canvasCropBox;
    const entry = f.clipBoxes[cropTool] as LocalShape | LocalPolygon | undefined;
    if (!entry) return null;
    if (isPolygon(entry)) {
      return geometry.polygon.polygonToSvgPathD(entry);
    }
    // LocalShape — the hook internally generates rect/ellipse path
    const shape = entry as LocalShape;
    return (shape.rect.w > 0) ? shape : null;
  };

  // Background path (black, offset phase) — fills the foreground gaps
  useFastMarchingAntsSync(pathBgRef, isActive, {
    selector: antsSelector,
    resetKey: cropTool,
  });

  // Foreground path (white/red, standard phase)
  useFastMarchingAntsSync(pathRef, isActive, {
    selector: antsSelector,
    resetKey: cropTool,
  });

  // Dynamic fill: transparent fill for polygons (evenodd), none for shapes
  useFastSync(pathRef, isActive, (_v, f) => {
    if (!pathRef.current) return;
    if (isReCanvas) {
      pathRef.current.setAttribute('fill', 'none');
      return;
    }
    const entry = f.clipBoxes[cropTool];
    const isPoly = entry && isPolygon(entry);
    pathRef.current.setAttribute('fill', isPoly ? 'rgba(240, 230, 255, 0.12)' : 'none');
  });

  // Group visibility: hidden when no data
  useFastSync(groupRef, isActive, (_v, f) => {
    if (!groupRef.current) return;
    if (isReCanvas) {
      groupRef.current.style.visibility = '';
      return;
    }
    const entry = f.clipBoxes[cropTool];
    const hasData = !!entry && (isPolygon(entry) || (entry as LocalShape).rect.w > 0);
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
export function useMoveDeltaSync(isActive: boolean, cropTool: ClipTool) {
  const deltaContainerRef = useRef<HTMLDivElement>(null);
  const { volatileRef } = useEditorServices();

  // ─── Position: anchor to selection's bottom-left corner (local space) ───
  useFastAnchorSync(deltaContainerRef, isActive, {
    selector: (_v, f) => {
      // Only position when a drag is active (transient has start data)
      const start = volatileRef.current.transient['clipMoveStart'] as { x: number; y: number } | undefined;
      if (!start) return null;

      const entry = f.clipBoxes[cropTool];
      if (!entry) return null;

      const rect = isPolygon(entry)
        ? (entry as LocalPolygon).rect
        : (entry as LocalShape).rect;

      // Anchor at bottom-left of the selection bounding rect
      return { x: rect.x, y: rect.y + rect.h };
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

    const entry = f.clipBoxes[cropTool];
    if (!entry) {
      el.style.display = 'none';
      return;
    }

    const currentRect = isPolygon(entry)
      ? (entry as LocalPolygon).rect
      : (entry as LocalShape).rect;

    const dx = Math.round(currentRect.x - start.x);
    const dy = Math.round(currentRect.y - start.y);

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
