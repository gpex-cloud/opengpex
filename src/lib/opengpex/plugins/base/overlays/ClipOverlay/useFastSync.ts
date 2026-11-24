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
import { useFastSync, useFastRectSync, useFastSvgGroupSync, useFastMarchingAntsSync } from '@opengpex/editor/core/state/volatile';
import { straightenPreviewRotation } from '@opengpex/editor/core/state/volatile/straighten';
import { LocalShape, LocalPolygon, Frame, CameraState } from '@opengpex/editor/core/types';
import { resolveAntsPath, simplifyPolygonForAnts, type AntsPathCache } from './ants/antsPath';

/** Grid phase identity: the target layer's origin fraction, 0 or 0.5 (see GeometryService.quantizeGridOffset). */
type GridOffset = { readonly x: number; readonly y: number };

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

// ─── useReCanvasBoxSync ────────────────────────────────────────────────────────

/**
 * Re-Canvas box positioning + visibility (Re-Canvas-exclusive since the
 * selection HUD unification): drives the draggable HTMLDivElement (resize
 * / move surface for the canvas-resize rect). Reads only canvasClipBox.
 */
export function useReCanvasBoxSync(
  ref: React.RefObject<HTMLElement | null>,
  isActive: boolean
) {
  // Box position (fast-track CSS left/top/width/height)
  useFastRectSync(ref, isActive, {
    selector: (_v, f) => f.canvasClipBox.rect,
    space: 'local'
  });

  // Visibility gate: hide when shape is empty (0×0)
  useFastSync(ref, isActive, (_v, f) => {
    const rect = f.canvasClipBox.rect;
    const isEmpty = rect.w <= 0 || rect.h <= 0;
    if (ref.current) {
      (ref.current as HTMLElement).style.visibility = isEmpty ? 'hidden' : '';
    }
  });

  // Cleanup: toggle box visibility on active state changes
  useEffect(() => {
    if (ref.current) (ref.current as HTMLElement).style.display = isActive ? '' : 'none';
  }, [isActive, ref]);

  return {};
}

// ─── Straighten preview fold ───────────────────────────────────────────────

/**
 * The committed selection entity folded through the live straighten drag
 * transient. During a content-transform drag the rendered pixels rotate via
 * the engine's pose-override seam, but `frame.confinement` is only rewritten
 * at materialization — reading it raw would leave the ants pinned while the
 * image turns, then snap at hand-over. Folding the polygon through the SAME
 * rotate primitive (`geometry.polygon.rotatePolygon`) with the SAME pivot +
 * angle the materializer uses makes the preview ≡ materialized by
 * construction. No drag in flight → the committed entity unchanged.
 */
function previewConfinement(
  v: { transient?: Record<string, unknown> } | undefined,
  f: Frame,
  geometry: { polygon: { rotatePolygon: (poly: LocalPolygon, center: { x: number; y: number }, angleRad: number) => LocalPolygon } },
): LocalPolygon | null {
  const entry = f.confinement as LocalPolygon | null;
  if (!entry) return null;
  const rot = straightenPreviewRotation(v?.transient);
  if (!rot) return entry;
  return geometry.polygon.rotatePolygon(entry, rot.pivot, (rot.thetaDeg * Math.PI) / 180);
}

// ─── useThirdsGridSync ──────────────────────────────────────────────────────

/**
 * Rule-of-thirds grid positioning + visibility for the CLIP-mode rect
 * selection. The grid is an ALWAYS-VISIBLE companion of the selection: it
 * does NOT ride the TransformHud gizmo container (whose hover-reveal would
 * hide the guides whenever the pointer leaves the frame) — it is an
 * independent box pinned to the selection's own rect by this hook, so the
 * guides stay up while dragging, hovering, or doing nothing at all.
 *
 * Reads only the frame-level selection entity (`frame.confinement.rect`),
 * folded through the live straighten drag transient when one is in flight
 * (the grid tracks the preview like the ants do; the rotated selection's
 * AABB is the honest axis-aligned box for a DOM-rect guide).
 * The caller gates the mount to rectangle-shaped selections; for any other
 * shape the rect still exists (its bounding box) but this hook simply pins
 * whatever rect it is given — the compositional-meaning gate is the
 * component's job, not the sync's.
 */
export function useThirdsGridSync(
  ref: React.RefObject<HTMLElement | null>,
  isActive: boolean
) {
  const { geometry } = useEditorServices();
  // Grid position (fast-track CSS left/top/width/height)
  useFastRectSync(ref, isActive, {
    selector: (v, f) => previewConfinement(v, f, geometry)?.rect ?? { x: 0, y: 0, w: 0, h: 0 },
    space: 'local'
  });

  // Cleanup: toggle grid visibility on active state changes
  useEffect(() => {
    if (ref.current) (ref.current as HTMLElement).style.display = isActive ? '' : 'none';
  }, [isActive, ref]);

  return {};
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
 * Edge-mode contract: `ss` renders the smooth
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
  // integer-translation drag fast path — rules in `./ants/antsPath`.
  const antsCacheRef = useRef<AntsPathCache | null>(null);

  // ─── [Perf C] Per-tick selector memo ─────────────────────────────────────
  // The bg and fg paths BOTH invoke the selector on the same ticker tick with
  // the SAME merged frame/cam snapshot objects (snapshot cache in useFastSync),
  // so matching identities ⇒ identical inputs ⇒ reuse the computed path
  // instead of resolving window + cache twice per tick.
  const antsMemoRef = useRef<{
    frame: Frame; cam: CameraState; gridOffsetKey: string; thetaKey: string;
    vw: number; vh: number; d: string;
  } | null>(null);

  // SVG group positioning (at bounding rect origin, frame-local space)
  useFastSvgGroupSync(groupRef, isActive, {
    selector: (v, f) => {
      if (isReCanvas) return f.canvasClipBox.rect;
      const entry = previewConfinement(v, f, geometry);
      if (!entry) return null;
      return entry.rect.w > 0 ? entry.rect : null;
    },
    space: 'local'
  });

  // Shared selector for both paths (bg + fg share the same geometry).
  const antsSelector = (v: { transient?: Record<string, unknown> }, f: Frame, cam: CameraState): LocalShape | string | null => {
    if (isReCanvas) return f.canvasClipBox;
    const rot = straightenPreviewRotation(v?.transient);
    const entry = previewConfinement(v, f, geometry);
    if (!entry) return null;

    // The straighten angle is part of the geometry identity: the committed
    // frame snapshot does NOT change while a drag rides the transient, so
    // without this key the memo below would serve the pre-rotation path for
    // the whole drag.
    const thetaKey = rot ? String(rot.thetaDeg) : '';
    const gridOffsetKey = `${gridOffset.x}_${gridOffset.y}`;
    const viewportDim = viewportDimRef.current;

    const memo = antsMemoRef.current;
    if (memo && memo.frame === f && memo.cam === cam && memo.gridOffsetKey === gridOffsetKey &&
        memo.thetaKey === thetaKey &&
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
    antsMemoRef.current = { frame: f, cam, gridOffsetKey, thetaKey, vw: viewportDim.w, vh: viewportDim.h, d: pathD };
    return pathD;
  };

  // Background path (black, offset phase) — fills the foreground gaps
  useFastMarchingAntsSync(pathBgRef, isActive, {
    selector: antsSelector,
  });

  // Foreground path (white/red, standard phase)
  useFastMarchingAntsSync(pathRef, isActive, {
    selector: antsSelector,
  });

  // Group visibility: hidden when no data
  useFastSync(groupRef, isActive, (_v, f) => {
    if (!groupRef.current) return;
    if (isReCanvas) {
      groupRef.current.style.visibility = '';
      return;
    }
    const entry = f.confinement as LocalPolygon | null;
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
