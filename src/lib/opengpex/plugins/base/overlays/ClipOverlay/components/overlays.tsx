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

import { useMemo, useRef } from "react";
import {
  useOverlayRotationSync,
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";
import { readPeelSession } from "../peel/session";
import { isPeelSettleInFlight } from "../peel/controller";
import { useClipOverlayCommands, useClipCursor, useSelectionHudAnchor } from "../hooks";
import { TransformHud } from "@opengpex/editor/widgets/affordances";
import { RuleOfThirdsGrid } from "./ThirdsGrid";
import { ReCanvasBar } from "./ReCanvasBar";
import { AntsLayer } from "../ants/AntsLayer";
import {
  useReCanvasBoxSync,
  useThirdsGridSync,
} from "../useFastSync";
import { PeelActionButtons } from "../peel/actions";
import { ClipOverlayAPI } from "../protocols";
import type { ClipOverlayConfig } from "../protocols";

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

  // A commit in flight (the 'committing' adjudication while the settle lock
  // is held) keeps the peel session VISIBLE: the HUD, its linked tone and the
  // action bar must not flicker away for the length of the bake, and the bar
  // is where the in-flight spinner lives. A persisted residue 'committing'
  // (no lock) stays invisible, exactly as before.
  const rawPeelSession = activeFrame ? readPeelSession(activeFrame) : null;
  const peelCommitting = rawPeelSession?.status === 'committing' && isPeelSettleInFlight();
  const peelSessionActive = rawPeelSession?.status === 'peeled' || peelCommitting;
  // Selection HUD (finding 17): ONE affordances-framework instance serves
  // every selection flavor — plain AND peel-session alike. The selection
  // polygon carries its orientation in its vertices for both flavors
  // (plain rotation writes rotated rings; session follows write the same
  // maps), so one anchor provider covers both and the flavor only changes
  // the DECLARATION: session adds the action bar and the linked tone.
  // Active in clip mode (gizmo + chips) and in pan sessions (action bar
  // only — pan offers no transform affordance, finding 13). Re-Canvas is
  // an exclusive modal and keeps its own decoupled box below.
  //
  // Wand exemption: a magic-wand result is a PICK, not a transformable
  // entity — no HUD, no gizmo, no scale/rotate affordance. A peel session
  // cut with the wand still shows the session HUD: the floating fragment
  // is the entity there, and its pose has nothing to do with the wand.
  const wandSelection = clipTool === 'wand' && !peelSessionActive;
  const selectionHudActive =
    ((isEditing && !wandSelection) || peelSessionActive) && !isReCanvas && hasSelection;

  // Rule-of-thirds guides: a rectangular lattice only carries compositional
  // meaning over a RECTANGLE, so the gate admits exactly two scenes — clip
  // mode with a rectangle-shaped selection (rect tool, classified 'rect' by
  // polygonToShape — boolean combinations under the rect tool can produce
  // multi-ring shapes whose lattice would lie), and Re-Canvas (whose
  // canvas-resize rect is always rectangular). Ellipse / lasso / wand / SAM
  // selections never see the grid: their shapes are not rectangles.
  //
  // In clip mode the grid is an INDEPENDENT always-visible box pinned to the
  // selection rect (useThirdsGridSync) — deliberately NOT a child of the
  // gizmo container, whose hover-reveal would hide the guides whenever the
  // pointer leaves the frame. The guides belong to the composition, not to
  // the interaction chrome: they stay up while dragging, hovering, or doing
  // nothing at all.
  const thirdsInClip = isClipActive && !isReCanvas && clipTool === 'rect' && clipType === 'rect' && hasSelection;

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

  // Re-Canvas box (DECOUPLED): the canvas-resize rect keeps the flat box
  // container for itself — it is pinned to rect, carries no gizmo, no
  // selection dim and no action bar, so it no longer shares the selection
  // HUD's container or sync hooks.
  useReCanvasBoxSync(
    boxRef,
    isReCanvas,
  );

  // Rule-of-thirds grid (clip mode): independent always-visible box pinned
  // to the selection rect — see the gate comment above for the mounting
  // rationale (deliberately outside the hover-revealed gizmo container).
  const thirdsGridRef = useRef<HTMLDivElement>(null);
  useThirdsGridSync(thirdsGridRef, thirdsInClip);

  // ─── Selection HUD declaration ──────────────────────────────────────────
  // The dimension chip shows for EVERY selection shape in clip mode —
  // never in pan — and honors the user toggle. The action bar shows
  // whenever a peel session is undecided (both modes). The move surface
  // rides the HUD container for rect/circle selections only (path
  // selections move by direct polygon drag, never a surface).
  const showDimensionLabel = clipConfig?.showDimensionLabel ?? true;
  const selectionDimActive = showDimensionLabel && isClipActive && !isReCanvas && hasSelection;
  const peelBarActive = peelSessionActive && !isReCanvas && hasSelection;
  // Reset-size is offered only once a bake changed the fragment's SIZE —
  // a rotation alone leaves nothing to reset.
  const peelSession = activeFrame ? readPeelSession(activeFrame) : null;
  const canResetSize = !!peelSession?.origin && !!peelSession.resized;
  const selectionHud = useSelectionHudAnchor();
  const selectionMoveSurface = isClipActive && !isReCanvas
    && isRegularTool && clipTool !== "pathellipse" && clipType !== "path";

  if (!activeFrame || !isOverlayActive) return null;

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: EDITOR_Z_INDEX.STAGE.OVERLAY }}
    >
      <AntsLayer
        isOverlayActive={isOverlayActive}
        isReCanvas={isReCanvas}
        isEditing={isEditing}
        marchingAntsAnimated={marchingAntsAnimated}
        gridOffset={antsGridOffset}
      />

      {/* Rule-of-thirds grid (clip mode, rect selection): ALWAYS visible —
          an independent box pinned to the selection rect by useThirdsGridSync,
          outside the gizmo container so hover-reveal never hides it. */}
      {thirdsInClip && (
        <div ref={thirdsGridRef} className="absolute top-0 left-0">
          <RuleOfThirdsGrid />
        </div>
      )}

      {/* Re-Canvas box (DECOUPLED): the canvas-resize rect's own flat
          container — pinned to rect, no gizmo, no selection chips. Presses
          are claimed by the Re-Canvas handlers through the data-handle
          attribute; the selection-gizmo scope does not apply here. The
          dimensions / presets / APPLY chrome lives in ReCanvasBar. */}
      {isReCanvas && (
        <div
          ref={boxRef}
          className="absolute pointer-events-auto transition-[border-radius] duration-300"
          data-handle="move"
        >
          {/* Rule-of-thirds guides: the Re-Canvas rect is always a plain
              axis-aligned rectangle, so the grid mounts as a direct child
              and tracks the box without any extra sync. */}
          <RuleOfThirdsGrid />
          <ReCanvasBar />
        </div>
      )}

      {/* Selection HUD (finding 17, unified): ONE TransformHud serves every
          selection flavor — plain and peel-session alike. The selection
          polygon is the orientation probe for both (plain rotation writes
          rotated rings; session follows write the same maps), so the gizmo
          container, the dimension chip and the action bar all follow the
          TRUE orientation live, at every angle. Flavor differences are
          declaration-only: session adds the action bar and the linked
          tone. The gizmo child mounts only in clip mode (pan offers no
          transform affordance — finding 13); the hover reveal, the
          move-surface attributes and the press scope attribute mirror the
          historical boxes exactly, so press routing
          (data-clip-selection-gizmo) is unchanged. */}
      {selectionHudActive && (
        <TransformHud
          active
          getAnchorFrame={selectionHud.getAnchorFrame}
          reveal="hover"
          gizmo={isClipActive ? {
            variant: 'cube',
            outline: true,
            tone: peelSessionActive ? 'linked' : 'default',
          } : undefined}
          pressScope="clip-selection"
          gizmoContainerProps={{ 'data-clip-selection-gizmo': true }}
          moveSurface={selectionMoveSurface}
          roundShape={clipType === 'circle'}
          dimension={selectionDimActive ? { text: selectionHud.getDimensionText } : undefined}
          actions={peelBarActive ? <PeelActionButtons canResetSize={canResetSize} committing={peelCommitting} /> : undefined}
          delta
        />
      )}

    </div>
  );
}
