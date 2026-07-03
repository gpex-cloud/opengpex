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
import { useFastSync, useFastRectSync, useFastSvgGroupSync, useFastMarchingAntsSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { LocalShape, LocalPolygon, asLocalShape, isPolygon } from '@opengpex/editor/core/types';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';

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
 * Replaces the old dual-channel architecture (useRegularCropSync ants +
 * useIrregularSelectionSync). A single SVG <g> + <path> renders:
 *   - Rect selections (4 points)
 *   - Ellipse selections (smooth arc)
 *   - Polygon selections (lasso / wand / inverted)
 *   - Re-Canvas (red rect, always a shape)
 *
 * The selector resolves data from the slot based on `cropTool` and converts
 * to SVG path `d` at the fast-track level (60fps). No React re-render needed
 * to switch between shape/polygon rendering.
 *
 * Fill is dynamically switched: `fill="none"` for shapes, semi-transparent
 * evenodd fill for polygons (helps visualize inside/outside of complex paths).
 */
export function useSelectionAntsSync(
  groupRef: React.RefObject<SVGGElement | null>,
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

  // Marching ants path d — unified selector handles both types
  useFastMarchingAntsSync(pathRef, isActive, {
    selector: (_v, f) => {
      if (isReCanvas) return f.canvasCropBox;
      const entry = f.clipBoxes[cropTool];
      if (!entry) return null;
      if (isPolygon(entry)) {
        return geometry.polygon.polygonToSvgPathD(entry as LocalPolygon);
      }
      // LocalShape — the hook internally generates rect/ellipse path
      const shape = entry as LocalShape;
      return (shape.rect.w > 0) ? shape : null;
    },
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

  // Cleanup on deactivation: hide group, clear path
  useEffect(() => {
    if (isActive) {
      if (groupRef.current) groupRef.current.style.display = '';
    } else {
      if (groupRef.current) groupRef.current.style.display = 'none';
      if (pathRef.current) pathRef.current.setAttribute('d', '');
    }
  }, [isActive, groupRef, pathRef]);
}
