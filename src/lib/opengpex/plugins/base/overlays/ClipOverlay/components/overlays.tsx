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

import { useCallback, useMemo, useRef } from "react";
import {
  useOverlayRotationSync,
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";
import { TransformGizmo } from "@opengpex/editor/widgets/TransformGizmo";
import { useClipOverlayCommands, useClipCursor, useGizmoHoverSync } from "../hooks";
import {
  useCropDimSync,
  useRegularBoxSync,
  useSelectionAntsSync,
  useMoveDeltaSync,
} from "../useFastSync";
import { lassoPreviewPathRef } from "../interactions";
import { MARCHING_ANTS_DURATION_S, ClipOverlayAPI } from "../protocols";
import type { ClipOverlayConfig } from "../protocols";

/* ─── Inline keyframes for marching ants (plugin-internal, no global CSS) ─── */
const CLIP_ANTS_STYLE = `
@keyframes clip-ants-flow {
  to { stroke-dashoffset: -12; }
}
`;

/**
 * ClipOverlayMain: UI layer for the cropping / selection tool.
 *
 * Architecture (2026-07-05 dual-path high-contrast):
 *
 *   - Dual-path marching ants <g> + 2×<path>: industry-standard Photoshop/
 *     GIMP technique — a black dashed background path (offset by half-period)
 *     paired with a white/red foreground dashed path. This ensures selection
 *     edges are clearly visible against ANY background (light checkerboard,
 *     dark images, white image edges). Renders ALL selection types (rect,
 *     ellipse, polygon, inverted) via `useSelectionAntsSync`.
 *
 *   - Lasso preview <path> (screen-space): live trail during pointer drag.
 *     Updated imperatively by `createLassoHandler` via `lassoPreviewPathRef`.
 *
 *   - Regular box (CSS div): gizmo mount, dim label.
 *     Only active when tool is regular (rect/ellipse) or Re-Canvas.
 *
 *   - Plugin-internal `<style>`: keyframes for the marching animation are
 *     defined inside this component (no global CSS dependency).
 */
export function ClipOverlayMain() {
  const {
    activeFrame,
    clipBox,
    isReCanvas,
    isClipActive,
    boxRef,
    clipType,
    clipTool,
    isRegularTool,
  } = useClipOverlayCommands();

  useClipCursor(isClipActive, clipTool, isReCanvas);

  const { state, activeLayer } = useEditorState();
  const { geometry } = useEditorServices();
  const overlayRef = useRef<HTMLDivElement>(null);

  useOverlayRotationSync(overlayRef, activeFrame);

  const clipConfig = state.pluginConfig[ClipOverlayAPI.configKey] as Partial<ClipOverlayConfig> | undefined;
  const marchingAntsAnimated = clipConfig?.marchingAntsAnimated ?? false;

  // ─── Activation gates ────────────────────────────────────────────────────
  // The selection is a document-level entity (frame.confinement), so the
  // ants must be visible in ANY mode while a selection exists — not just
  // inside clip mode. Two visual states:
  //   editing  (clip mode or Re-Canvas) → interactive: box, handles, dim and
  //             delta labels, marching animation per user preference
  //   passive  (any other mode)        → ants only, static dashes, zero
  //             interactivity (the whole overlay is pointer-events-none and
  //             the box/handles are not rendered)
  const hasSelection = !!activeFrame?.confinement;
  const isEditing = isClipActive || isReCanvas;
  const isOverlayActive = isEditing || hasSelection;

  // Box (handles + dim label): only while editing, and only when the
  // selection itself is a regular shape (rect/circle) — TRANSFORM IS
  // SELECTION-ORIENTED, not tool-oriented: a path selection shows the shared
  // TransformGizmo under ANY selection tool, so the rect-bracket box must
  // yield whenever the entity is a path polygon.
  const boxActive = isEditing
    && (isReCanvas || (isRegularTool && clipTool !== "pathellipse" && clipType !== "path"));

  // Gizmo box for every PATH selection regardless of the armed tool
  // (lasso/wand/pathellipse/boolean results): TransformGizmo corner/edge
  // scale handles + rotation dot (SelectionTransformHandler). Same fast-sync
  // hook as the regular box — resolveRegularClip reads frame.confinement
  // directly, so polygon bbox positioning works unchanged.
  const gizmoBoxActive = isEditing && !isReCanvas && hasSelection
    && clipType === "path";

  // ─── Staircase grid phase (ants/GPU alignment) ───────────────────────────
  // The aa/na ants are the pixel staircase of the TARGET layer's (active
  // layer's) pixel grid. That grid sits at the layer's origin in frame-local
  // space, whose offset fraction is 0 or 0.5 (odd canvas dims shift it by .5)
  // — the staircase must use this phase or the ants and the GPU-cut pixels
  // misalign by 1px. Layers with other offsets don't match the ants
  // pixel-for-pixel (accepted).
  const antsGridOffset = useMemo(() => {
    if (!activeLayer || !activeFrame) return { x: 0, y: 0 };
    const m = geometry.transform.getLayerLocalMatrix(activeLayer, activeFrame);
    return { x: geometry.camera.quantizeGridOffset(m.tx), y: geometry.camera.quantizeGridOffset(m.ty) };
  }, [activeLayer, activeFrame, geometry]);

  // ─── Fast-track hooks ────────────────────────────────────────────────────

  // Unified marching ants (dual-path: black base + white/red foreground)
  const groupRef = useRef<SVGGElement>(null);
  const pathBgRef = useRef<SVGPathElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  useSelectionAntsSync(groupRef, pathBgRef, pathRef, isOverlayActive, isReCanvas, antsGridOffset);

  // CSS box (move surface + gizmo mount, regular tools only)
  useRegularBoxSync(
    boxRef,
    boxActive,
    isReCanvas,
  );

  // Gizmo box for path-polygon selections: corner scale handles + rotation
  // handle via the shared TransformGizmo. Hover-reveal (PS Transform
  // Selection): hidden until the pointer enters the selection, hidden again
  // during any gesture drag.
  const irregularBoxRef = useRef<HTMLDivElement>(null);
  useRegularBoxSync(irregularBoxRef, gizmoBoxActive, false);
  useGizmoHoverSync(irregularBoxRef, gizmoBoxActive);

  // Rect-shaped selections ride the SAME gizmo (one transform logic for all
  // selection shapes), rendered inside the regular box; hover-reveal identical.
  const rectGizmoRef = useRef<HTMLDivElement>(null);
  useGizmoHoverSync(rectGizmoRef, boxActive && hasSelection && !isReCanvas);

  // Dimension label
  const { dimLabelRef } = useCropDimSync(boxActive, isReCanvas);

  // Move-delta label (shows "Δ dx, dy" during selection drag)
  const { deltaContainerRef } = useMoveDeltaSync(isOverlayActive);

  // ─── Lasso preview path ref callback ─────────────────────────────────────
  const previewPathRef = useRef<SVGPathElement | null>(null);
  const setPreviewPathRef = useCallback((el: SVGPathElement | null) => {
    previewPathRef.current = el;
    lassoPreviewPathRef.current = el;
  }, []);

  if (!activeFrame || !isOverlayActive) return null;

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: EDITOR_Z_INDEX.STAGE.SYSTEM_TOOLS }}
    >
      {/* Plugin-internal keyframes for marching ants animation */}
      <style dangerouslySetInnerHTML={{ __html: CLIP_ANTS_STYLE }} />

      {/* SVG layer: marching ants + lasso preview */}
      <div className="absolute inset-0 pointer-events-none overflow-visible">
        <svg className="absolute inset-0 w-full h-full overflow-visible">
          {/* Dual-path marching ants: black base fills white gaps for max contrast.
              This is the Photoshop/GIMP industry standard technique — ensures
              selection edges are visible against ANY background color. */}
          <g ref={groupRef}>
            {/* Base layer: solid black/dark-red line (always visible, provides contrast) */}
            <path
              ref={pathBgRef}
              fill="none"
              fillRule="evenodd"
              stroke={isReCanvas ? "#7f1d1d" : "black"}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            {/* Foreground layer: dashes (animated or static based on MARCHING_ANTS_ANIMATED) */}
            <path
              ref={pathRef}
              fill="none"
              fillRule="evenodd"
              stroke={isReCanvas ? "#ef4444" : "white"}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              style={{
                strokeDasharray: '6, 6',
                ...(marchingAntsAnimated && isEditing
                  ? { animation: `clip-ants-flow ${MARCHING_ANTS_DURATION_S}s linear infinite` }
                  : {}),
              }}
            />
          </g>

          {/* Lasso preview (screen-space, during pointer drag) */}
          <path
            ref={setPreviewPathRef}
            fill="none"
            fillRule="evenodd"
            stroke="#f0e6ff"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
            style={{
              strokeDasharray: '4, 4',
              ...(marchingAntsAnimated
                ? { animation: 'clip-ants-flow 0.4s linear infinite' }
                : {}),
            }}
          />
        </svg>
      </div>

      {/* Regular crop box: gizmo mount + dim label.
          Hidden when tool is irregular, data is polygon (via visibility gate),
          or the overlay is in passive (non-editing) view. */}
      {boxActive && (
        <div
          ref={boxRef}
          className="absolute pointer-events-auto transition-[border-radius] duration-300"
          style={{ borderRadius: clipType === "circle" ? "50%" : "0%" }}
          data-handle="move"
        >
          {/* Shared TransformGizmo: THE selection handles for every shape —
              corner/edge scale + rotation dot, same knobs as marker/text,
              claimed by SelectionTransformHandler. Scale of a rect-shaped
              selection through the gizmo drives the same ring-affine math as
              path selections (one transform logic, per the selection-oriented
              ruling). Re-Canvas keeps its own red-styled marks, so the gizmo
              is skipped in that modal. Visibility: same JS hover-reveal as
              the path gizmo box (hidden until the pointer enters the
              selection, hidden during any gesture drag). */}
          {!isReCanvas && hasSelection && (
            <div
              ref={rectGizmoRef}
              className="absolute inset-0 pointer-events-none"
              style={{ opacity: 0 }}
            >
              <TransformGizmo variant="cube" outline />
            </div>
          )}

          {/* Dimension Labels */}
          <div
            className="absolute left-0 bg-zinc-900/90 backdrop-blur-md border border-white/10 rounded flex items-center shadow-2xl pointer-events-none whitespace-nowrap"
            style={{
              top: "calc(100% + 6px)",
              padding: "1px 5px",
              gap: "2px",
              transformOrigin: "top left",
            }}
          >
            <span
              ref={dimLabelRef}
              className="text-[11px] font-black text-white tabular-nums tracking-tighter"
            >
              {Math.round(clipBox.w)} × {Math.round(clipBox.h)}
            </span>
            <span className="text-[11px] font-bold text-white/40 ml-0.5">px</span>
          </div>

        </div>
      )}

      {/* Irregular selection box: shared TransformGizmo (corner + edge scale
          handles and rotation dot, same knobs as marker/text). The container
          is pointer-events-none (unlike the regular box, there is no "move
          surface" — moving an irregular selection is a direct drag on the
          polygon, handled by the move handler); the gizmo's hit zones are
          individually interactive and consumed by SelectionTransformHandler. */}
      {gizmoBoxActive && (
        <div
          ref={irregularBoxRef}
          className="absolute pointer-events-none"
          style={{ opacity: 0 }}
        >
          <TransformGizmo variant="cube" outline />
        </div>
      )}

      {/* Move-delta label: independently positioned via useFastAnchorSync.
          Works for ALL selection types (regular + irregular). */}
      <div
        ref={deltaContainerRef}
        className="absolute top-0 left-0 bg-zinc-900/90 backdrop-blur-md border border-white/10 rounded flex items-center shadow-2xl pointer-events-none whitespace-nowrap"
        style={{
          padding: "1px 5px",
          gap: "2px",
          display: 'none',
        }}
      >
        <span className="text-[11px] font-black text-emerald-400 tabular-nums tracking-tighter" />
        <span className="text-[11px] font-bold text-white/40 ml-0.5">px</span>
      </div>
    </div>
  );
}
