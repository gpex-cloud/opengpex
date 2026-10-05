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

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useEditorServices, useEditorState } from '@opengpex/editor/core/context';
import { useFastSync, useFastRectSync, useFastSvgGroupSync, useFastMarchingAntsSync, useFastAnchorSync } from '@opengpex/editor/core/state/volatile';
import { LocalShape, LocalPolygon, asLocalShape, Frame, CameraState } from '@opengpex/editor/core/types';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import { ClipTool } from '../../options/ClipOptions/protocols';
import { resolveAntsPath, simplifyPolygonForAnts, type AntsPathCache } from './antsPath';

/** Grid phase identity: the target layer's origin fraction, 0 or 0.5 (see GeometryService.quantizeGridOffset). */
type GridOffset = { readonly x: number; readonly y: number };

const EMPTY_SHAPE: LocalShape = asLocalShape({ x: 0, y: 0, w: 0, h: 0 });

// ─── Marching Ants Path Derivation ──────────────────────────────────────────────

// Derivation + cache rules live in `./antsPath` (pure, unit-tested); this file
// keeps only the ticker wiring. The visible window comes from the geometry
// infra in ONE call — `geometry.camera.visibleGridWindow` (camera map + half-
// diagonal margin + 128 CSS px block quantization + LocalRect→grid-cell
// conversion). Photoshop model: the ants are a VIEWPORT artifact — deriving
// only the visible cells keeps every re-rasterization (pan/zoom transform
// change, dash animation frame) at O(visible arc) instead of O(full perimeter
// × device zoom), which is what burned energy on 4K selections at high
// magnification.

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
  return { type: 'rect', rect, antiAliased, __brand: 'local' } as LocalShape;
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
  isReCanvas: boolean
) {
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

  // Cleanup: toggle box + guides visibility on active state changes
  useEffect(() => {
    if (isActive) {
      if (ref.current) (ref.current as HTMLElement).style.display = '';
      if (guidesRef.current) {
        guidesRef.current.style.display = '';
        guidesRef.current.style.opacity = '0.2';
      }
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
 * Edge-mode contract (P1 staircase unification): `ss` renders the smooth
 * geometry (DP-simplified); `aa`/`na` render the IDENTICAL pixel staircase
 * derived from the raw rings on the target layer's pixel grid — which is why
 * `gridOffset` (the active layer's grid offset, the origin fraction) is a
 * required input for irregular selections.
 *
 * Viewport culling (2026-10-05): the aa/na staircase is derived ONLY for the
 * cells inside the visible window (+ margin, block-snapped — see
 * `computeAntsWindow`). Contours close along the window edges, so the drawn
 * path stays viewport-sized; panning/zooming re-derives lazily and cheaply.
 *
 * NO semi-transparent fill: the evenodd tint (`rgba(240,230,255,0.06)`) that
 * used to visualize the selection interior was removed (user decision) — when
 * the selection covered the viewport it painted a full-screen translucent
 * layer on EVERY pan/zoom frame (sustained GPU load / heat) while carrying
 * zero inside/outside information. Both ant paths render stroke-only
 * (`fill="none"` in overlays.tsx).
 */
export function useSelectionAntsSync(
  groupRef: React.RefObject<SVGGElement | null>,
  pathBgRef: React.RefObject<SVGPathElement | null>,
  pathRef: React.RefObject<SVGPathElement | null>,
  isActive: boolean,
  isReCanvas: boolean,
  clipTool: string,
  gridOffset: GridOffset = { x: 0, y: 0 }
) {
  const { geometry } = useEditorServices();
  const { state } = useEditorState();
  const viewportDimRef = useRef(state.ui.viewportDim);
  useLayoutEffect(() => {
    viewportDimRef.current = state.ui.viewportDim;
  }, [state.ui.viewportDim]);

  // ─── [Perf A] Derivation cache ───────────────────────────────────────────
  // Four-key cache (rings ref + mode + grid phase + visible window) with the
  // integer-translation drag fast path — rules in `./antsPath`.
  const antsCacheRef = useRef<AntsPathCache | null>(null);

  // ─── [Perf C] Per-tick selector memo ─────────────────────────────────────
  // The bg and fg paths BOTH invoke the selector on the same ticker tick with
  // the SAME merged frame/cam snapshot objects (snapshot cache in useFastSync),
  // so matching identities ⇒ identical inputs ⇒ reuse the computed path
  // instead of resolving window + cache twice per tick.
  const antsMemoRef = useRef<{
    frame: Frame; cam: CameraState; gridOffsetKey: string;
    vw: number; vh: number; d: string;
  } | null>(null);

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
  const antsSelector = (_v: unknown, f: Frame, cam: CameraState): LocalShape | string | null => {
    if (isReCanvas) return f.canvasClipBox;
    const entry = f.clipBoxes[clipTool] as LocalPolygon | undefined;
    if (!entry) return null;

    const gridOffsetKey = `${gridOffset.x}_${gridOffset.y}`;
    const viewportDim = viewportDimRef.current;

    const memo = antsMemoRef.current;
    if (memo && memo.frame === f && memo.cam === cam && memo.gridOffsetKey === gridOffsetKey &&
        memo.vw === viewportDim.w && memo.vh === viewportDim.h) {
      return memo.d;
    }

    // Viewport window for the staircase (aa/na only — ss is viewport-agnostic).
    const mode = geometry.polygon.deriveEdgeDisplayMode(entry.antiAliased, entry.ssdepMode);
    const { window, key: windowKey } = mode === 'ss'
      ? { window: undefined, key: 'full' }
      : geometry.camera.visibleGridWindow(viewportDim, cam, gridOffset);

    // Cache hit paths: same rings reference AND same edge mode AND same grid
    // phase AND same visible window — OR a pure INTEGER translation of the
    // cached rings (all four keys equal). Otherwise a full O(H·k+P) derivation.
    const { pathD, cache } = resolveAntsPath(antsCacheRef.current, {
      entry,
      mode,
      gridOffsetKey,
      windowKey,
      derive: () => mode === 'ss'
        ? geometry.polygon.polygonToSvgPathD(simplifyPolygonForAnts(entry, geometry.polygon.simplifyRing))
        : geometry.polygon.polygonToSvgPathD(entry, gridOffset, window),
    });

    antsCacheRef.current = cache;
    antsMemoRef.current = { frame: f, cam, gridOffsetKey, vw: viewportDim.w, vh: viewportDim.h, d: pathD };
    return pathD;
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
