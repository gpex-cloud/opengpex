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
  useOverlayRotationSync,
} from '@opengpex/editor/core/context';
import { TransformHud } from '@opengpex/editor/widgets/affordances';
import { usePenHudAnchor } from './usePenHudAnchor';
import type { Layer } from '@opengpex/editor/core/types';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import { usePenSurfaceSync } from './useFastSync';
import { usePenToolLifecycle } from './hooks';
import { setPenRubberLine, setPenSurfaceGroup } from './interactions';

/**
 * PenOverlayMain: SVG overlay for the pen tool.
 *
 * The PenSurface stays MOUNTED whenever a frame exists: with the pen tool
 * inactive it shows the persisted draft as a bare outline (the Photoshop
 * Work Path behavior — the draft is document state and must not vanish
 * when the user switches tools). The edit affordances are tool-gated:
 * - PenRubberBand (marching-ants line) and PenGizmo only render while
 *   activeCraft === 'pen'.
 * - PenSurface switches to outline mode via usePenSurfaceSync's flag.
 *
 * PenSurface: viewport-sized SVG (screen px) with the draft (anchors,
 * handles when editing) and every visible committed pen path, imperatively
 * repainted by usePenSurfaceSync (60fps, no React re-render during
 * gestures).
 *
 * Cursor + keyboard grammar live in usePenToolLifecycle (called before the
 * early return so hook ordering holds).
 */
export const PenOverlayMain = React.memo(function PenOverlayMain() {
  const { state, activeFrame } = useEditorState();
  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft] as string | null;
  const isPenMode = activeCraft === 'pen';

  // Cursor + keyboard lifecycle (self-gated on isPenMode; runs every render).
  // Returns THE pen escape ladder — the gizmo's Exit button runs it too.
  const runEscape = usePenToolLifecycle(isPenMode);

  if (!activeFrame) return null;
  return (
    <>
      <PenSurface outlineOnly={!isPenMode} />
      {/* The pen delta chip is NOT tool-gated: a pen layer can be moved or
          rotated by the generic LayerMoveHandler in any mode (pan-mode bare
          drag, Cmd spring drag), and its chip must follow. Chip-only — the
          framework renders no gizmo container for it. */}
      <PenChipHud />
      {isPenMode && <PenRubberBand />}
      {isPenMode && <PenGizmo onExit={runEscape} />}
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

const PenSurface = React.memo(function PenSurface({ outlineOnly = false }: { outlineOnly?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const { activeFrame } = useEditorState();

  usePenSurfaceSync(containerRef, groupRef, !!activeFrame, outlineOnly);
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

// ─── PenChipHud ────────────────────────────────────────────────────────────────

/**
 * PenChipHud: the pen tool's chips-only TransformHud — the ONE owner of
 * every layer-target pen gesture's delta chip, in every mode.
 *
 * Keying mirrors MarkerChipHud: the chip anchors to the ACTIVE layer while
 * it is a host pen layer. All movers (pen move/rotate handlers and the
 * generic LayerMoveHandler) set the dragged layer active in onStart, so
 * the active layer id always equals the gesture record's `targetId`.
 * Non-pen active layers yield a null anchor and the chip stays hidden.
 *
 * The gizmo HUD (PenGizmo) deliberately carries NO delta: in the pen tool
 * both HUDs are alive and a delta there would paint a second chip.
 */
const PenChipHud = React.memo(function PenChipHud() {
  const { activeLayer } = useEditorState();
  const isPenLayer =
    !!activeLayer && activeLayer.type === 'vector' && !!activeLayer.penData
    && (!activeLayer.role || activeLayer.role === 'host');
  const { getAnchorFrame } = usePenHudAnchor(
    isPenLayer && activeLayer ? activeLayer.id : null,
  );

  if (!isPenLayer || !activeLayer) return null;
  return (
    <TransformHud
      active
      getAnchorFrame={getAnchorFrame}
      delta={{ targetId: activeLayer.id }}
    />
  );
});

// ─── PenGizmo ──────────────────────────────────────────────────────────────────

/**
 * PenGizmo: the active pen layer's transform HUD — the gizmo declaration
 * (corner brackets, live rotation/flip) presented through the TransformHud
 * framework. The framework's anchor sync positions the rotated container
 * per tick (usePenHudAnchor — the same live world-matrix x camera
 * projection the historical fast-sync box hand-rolled). NO delta here:
 * the always-mounted PenChipHud owns every layer-target pen chip; a delta
 * on this HUD would paint a second chip for the same gesture.
 *
 * Press routing stays with the pen handlers: pen-resize (priority 165)
 * claims `[data-pen-gizmo] [data-gizmo-handle]` presses and bakes the
 * scale into penData; pen-rotate (166) claims `[data-pen-gizmo]
 * [data-gizmo-rotate]` and rides the layer's rotation channel. Both
 * handlers gate on the pen craft, so pen-edit / pen-draw never see handle
 * presses (their shared gate also filters the gizmo elements defensively).
 */
const PenGizmo = React.memo(function PenGizmo({ onExit }: { onExit: () => void }) {
  const { activeFrame } = useEditorState();
  const { state } = useEditorState();

  const activeLayer: Layer | null = activeFrame?.activeLayerId
    ? activeFrame.layers.byId[activeFrame.activeLayerId] ?? null
    : null;
  // Host layers only: fragment-triplet sub-layers (frag/exchange) are engine
  // clones and never get the pen gizmo.
  const layerId = activeLayer && activeLayer.type === 'vector' && !!activeLayer.penData
      && (!activeLayer.role || activeLayer.role === 'host')
    ? activeLayer.id
    : null;

  const { getAnchorFrame } = usePenHudAnchor(layerId);

  if (!activeFrame || !layerId) return null;

  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-visible"
      style={{ zIndex: 20 }}
    >
      <TransformHud
        active
        getAnchorFrame={getAnchorFrame}
        gizmo={{
          // Edge-resize mode: full-length hit strips on all four sides
          // (drag anywhere on a border for single-axis resize) plus the
          // visible midpoint ticks. The corner brackets stay as-is.
          outline: true,
          rotation: state.interaction.isInteracting ? undefined : activeLayer?.rotation ?? 0,
          flip: activeLayer?.flip,
        }}
        pressScope="pen-gizmo"
        actions={
          <button
            type="button"
            onClick={onExit}
            title="Exit (Esc)"
            aria-label="Exit"
            className="flex items-center outline-none rounded px-1 text-[10px] font-bold leading-none text-rose-400 hover:bg-white/10 pointer-events-auto cursor-pointer"
            style={{ height: '16px' }}
          >
            Esc
          </button>
        }
      />
    </div>
  );
});
