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

'use client';

import React, { useRef } from 'react';
import {
  useEditorState,
  useEditorServices,
  useOverlayRotationSync,
} from '@opengpex/editor/core/context';
import { TransformGizmo } from '@opengpex/editor/widgets/TransformGizmo';
import type { Frame, Layer, VolatileState, CameraState } from '@opengpex/editor/core/types';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import { usePenSurfaceSync } from './useFastSync';
import { usePenToolLifecycle } from './hooks';
import { setPenRubberLine, setPenSurfaceGroup } from './interactions';

/**
 * PenOverlayMain: SVG overlay for the pen tool.
 *
 * Renders in STAGE_OVERLAY while activeCraft === 'pen':
 * - PenSurface: viewport-sized SVG (screen px) with the draft session (anchors,
 *   handles) and every visible committed pen path, imperatively repainted
 *   by usePenSurfaceSync (60fps, no React re-render during gestures).
 * - PenRubberBand: screen-space marching-ants line from the last anchor to
 *   the cursor, moved directly by the pointer listener.
 * - PenGizmo: the shared TransformGizmo (corner variant) over the ACTIVE
 *   pen layer — the same self-rendered selection frame TextOverlay and
 *   MarkerOverlay draw in their own overlays.
 *
 * Cursor + keyboard grammar live in usePenToolLifecycle (called before the
 * early return so hook ordering holds).
 */
export const PenOverlayMain = React.memo(function PenOverlayMain() {
  const { state, activeFrame } = useEditorState();
  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft] as string | null;
  const isPenMode = activeCraft === 'pen';

  // Cursor + keyboard lifecycle (self-gated on isPenMode; runs every render).
  usePenToolLifecycle(isPenMode);

  if (!isPenMode || !activeFrame) return null;
  return (
    <>
      <PenSurface />
      <PenRubberBand />
      <PenGizmo />
    </>
  );
});

// ─── PenRubberBand ─────────────────────────────────────────────────────────────

/**
 * Screen-space rubber band from the open subpath's last anchor to the cursor:
 * the selection ants' dual-path recipe (solid black base + white 6/6 dashes,
 * 1px, static) in a viewport-sized SVG that is NOT camera-scaled, so the
 * hairline rasterizes crisply at any zoom. Endpoints are written imperatively
 * (placePenRubberTip / movePenRubberTip); the group starts hidden.
 */
const PenRubberBand = React.memo(function PenRubberBand() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeFrame } = useEditorState();

  // Same rotation-ride as PenSurface: the band's endpoints are written in
  // viewport screen px, so the container must follow the viewport's
  // counter-rotation tween or the band detaches from the draft mid-rotation.
  useOverlayRotationSync(containerRef, activeFrame);

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none overflow-visible">
      <svg className="absolute inset-0 w-full h-full overflow-visible">
        <g ref={setPenRubberLine} visibility="hidden">
          <line stroke="black" strokeWidth="1" />
          <line stroke="white" strokeWidth="1" style={{ strokeDasharray: '6, 6' }} />
        </g>
      </svg>
    </div>
  );
});

// ─── PenSurface ────────────────────────────────────────────────────────────────

/* Anchor/handle hover: pop (overshoot scale), full recolour (fill + stroke)
   and a glow — the strongest attention cues on photo backdrops. Applied by
   direct DOM attribute writes from the pointer listener (see
   setPenAnchorHover) — the overlay is pointer-events-none, so :hover cannot
   fire, and transform-box: fill-box scales the rect around its own center. */
const PEN_SURFACE_STYLE = `
  .pen-anchor, .pen-handle {
    transform-box: fill-box; transform-origin: center;
    transition: transform 140ms cubic-bezier(0.34, 1.56, 0.64, 1), fill 90ms ease-out, stroke 90ms ease-out;
  }
  .pen-anchor[data-hover] { transform: scale(2); fill: #fbbf24; stroke: #0d99ff; stroke-width: 1px; }
  .pen-handle[data-hover] { transform: scale(2); fill: #ef4444; stroke: #0d99ff; stroke-width: 1px; }
`;

const PenSurface = React.memo(function PenSurface() {
  const containerRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const { activeFrame } = useEditorState();

  usePenSurfaceSync(containerRef, groupRef, !!activeFrame);
  // Ride the viewport rotation's counter-rotation tween (same protocol as the
  // marker/layer/clip overlays) — without it the draft anchors/lines snap to
  // the new orientation in one frame while the canvas tweens.
  useOverlayRotationSync(containerRef, activeFrame);

  if (!activeFrame) return null;

  // Viewport-sized, unscaled SVG: the fragment is built in screen px (see
  // render.ts), so strokes rasterize crisply at any zoom.
  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none overflow-visible">
      <style dangerouslySetInnerHTML={{ __html: PEN_SURFACE_STYLE }} />
      <svg className="absolute inset-0 w-full h-full overflow-visible">
        <g ref={(el) => { groupRef.current = el; setPenSurfaceGroup(el); }} />
      </svg>
    </div>
  );
});

// ─── PenGizmo ──────────────────────────────────────────────────────────────────

/**
 * Selection frame (TransformGizmo, corner variant) over the active pen layer.
 * Positioned outside React by usePenGizmoSync at 60fps — identical mechanics
 * to MarkerSelectionBox's active box. The handles are LIVE: pen-resize
 * (priority 165) claims `[data-gizmo-handle]` presses and bakes the scale
 * into penData; pen-rotate (166) claims `[data-gizmo-rotate]` and rides the
 * layer's rotation channel. Both handlers gate on the pen craft, so pen-edit
 * / pen-draw never see handle presses (their shared gate also filters the
 * gizmo elements defensively).
 */
const PenGizmo = React.memo(function PenGizmo() {
  const { activeFrame } = useEditorState();
  const { state } = useEditorState();
  const containerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const activeLayer: Layer | null = activeFrame?.activeLayerId
    ? activeFrame.layers.byId[activeFrame.activeLayerId] ?? null
    : null;
  // Host layers only: fragment-triplet sub-layers (frag/exchange) are engine
  // clones and never get the pen gizmo.
  const layerId = activeLayer && activeLayer.type === 'vector' && !!activeLayer.penData
      && (!activeLayer.role || activeLayer.role === 'host')
    ? activeLayer.id
    : null;

  useOverlayRotationSync(containerRef, activeFrame);
  usePenGizmoSync(boxRef, layerId);

  if (!activeFrame || !layerId) return null;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none overflow-visible"
      style={{ zIndex: 20 }}
    >
      <div
        ref={boxRef}
        data-overlay-gizmo-layer={layerId}
        className="absolute top-0 left-0"
        style={{ display: 'none', transformOrigin: '0 0', willChange: 'transform, width, height' }}
      >
        <TransformGizmo
          rotation={state.interaction.isInteracting ? undefined : activeLayer?.rotation ?? 0}
          flip={activeLayer?.flip}
        />
      </div>
    </div>
  );
});

/**
 * usePenGizmoSync: positions the gizmo box over the active pen layer,
 * following camera + live fast-track pose (same math as the marker
 * selection box sync: full world matrix × camera, scale split from rotation
 * so the outline keeps constant screen weight).
 */
function usePenGizmoSync(
  boxRef: React.RefObject<HTMLDivElement | null>,
  layerId: string | null,
) {
  const { geometry } = useEditorServices();

  useFastSync(boxRef, !!layerId, (_v: VolatileState, f: Frame, cam: CameraState) => {
    const el = boxRef.current;
    if (!el || !layerId) return;

    const layer = f.layers.byId[layerId];
    if (!layer || layer.type !== 'vector' || !layer.penData) {
      el.style.display = 'none';
      return;
    }

    const worldMatrix = geometry.transform.getLayerWorldMatrix(layer);
    const viewMatrix = geometry.camera.getCameraMatrix(f, cam);
    const screenMatrix = viewMatrix.multiply(worldMatrix);

    const w = layer.bounding.w;
    const h = layer.bounding.h;
    const matrix = { ...screenMatrix, w, h };
    const { scaleX, scaleY } = geometry.transform.decomposeMatrix(matrix);

    const pureA = matrix.a / (scaleX || 0.001);
    const pureB = matrix.b / (scaleX || 0.001);
    const pureC = matrix.c / (scaleY || 0.001);
    const pureD = matrix.d / (scaleY || 0.001);

    el.style.display = 'block';
    el.style.width = `${w * scaleX}px`;
    el.style.height = `${h * scaleY}px`;
    el.style.transform = `matrix(${pureA}, ${pureB}, ${pureC}, ${pureD}, ${matrix.tx}, ${matrix.ty})`;
  }, { throttleHz: 60 });
}
