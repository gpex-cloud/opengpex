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

import React from 'react';
import { useEditorState, useEditorServices, useOverlayRotationSync } from '@opengpex/editor/core/context';
import { ROTATE_CURSOR } from '@opengpex/editor/icons';
import { cursorForScreenAngle } from '@opengpex/editor/widgets/TransformGizmo';
import { BoxCorners, CORNER_OUTSET_X_PX, CORNER_OUTSET_Y_PX } from './BoxCorners';
import { usePreEditFrameSync } from '../useFastSync';
import { TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID } from '../protocols';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import type { Layer } from '@opengpex/editor/core/types';

// ─── Sizing constants (screen px; the frame box carries no camera scale) ──────

/** Hit-zone side for the corner handles (invisible, centred on each corner). */
const CORNER_HIT_PX = 18;

/** Hit-zone size for the edge ticks: elongated along the edge for easy grab. */
const EDGE_HIT_LONG_PX = 24;
const EDGE_HIT_SHORT_PX = 14;

/** Visible edge tick length and stroke widths — same dual-stroke style as BoxCorners. */
const EDGE_TICK_LEN_PX = 12;
const EDGE_TICK_STROKE_W = 2;

/** Rotation handle dot size and distance above the top edge (screen px). */
const ROTATE_HANDLE_PX = 10;
const ROTATE_HANDLE_OFFSET_PX = 24;

/**
 * The 4 corner handles: direction label (mirrors TransformGizmo's
 * `data-gizmo-handle` values so TextResizeHandler's diagonal-resize math works
 * unchanged), the local outward-normal angle used for the rotation-aware
 * cursor, and the CSS anchor on the frame box.
 */
const CORNER_HANDLES: readonly { dir: 'nw' | 'ne' | 'sw' | 'se'; angle: number; style: React.CSSProperties }[] = [
  { dir: 'nw', angle: 225, style: { top: 0, left: 0 } },
  { dir: 'ne', angle: 315, style: { top: 0, left: '100%' } },
  { dir: 'sw', angle: 135, style: { top: '100%', left: 0 } },
  { dir: 'se', angle: 45, style: { top: '100%', left: '100%' } },
];

/**
 * The 4 edge-tick handles: single-axis resize (`n`/`s`/`e`/`w`), anchored at
 * the edge midpoints pushed OUTWARD by the same outset BoxCorners uses, so
 * the ticks sit exactly on the LayerOverlay hover outline line (which is
 * itself outset from the bounding rect) instead of floating inside it.
 */
const EDGE_HANDLES: readonly { dir: 'n' | 's' | 'e' | 'w'; angle: number; style: React.CSSProperties }[] = [
  {
    dir: 'n', angle: 270,
    style: { top: `calc(-1 * var(--box-corner-scale, 1) * ${CORNER_OUTSET_Y_PX}px)`, left: '50%' },
  },
  {
    dir: 's', angle: 90,
    style: { top: `calc(100% + var(--box-corner-scale, 1) * ${CORNER_OUTSET_Y_PX}px)`, left: '50%' },
  },
  {
    dir: 'w', angle: 180,
    style: { top: '50%', left: `calc(-1 * var(--box-corner-scale, 1) * ${CORNER_OUTSET_X_PX}px)` },
  },
  {
    dir: 'e', angle: 0,
    style: { top: '50%', left: `calc(100% + var(--box-corner-scale, 1) * ${CORNER_OUTSET_X_PX}px)` },
  },
];

/**
 * EdgeTick: a short mark lying ALONG the border at an edge midpoint — the
 * visible half of the edge handle (n/s → horizontal bar on the top/bottom
 * border, e/w → vertical bar on the left/right border). Same black-underlay +
 * white-core dual stroke as BoxCorners; the frame box is screen-px so the
 * natural size is already screen-constant (no counter-scale).
 */
const EdgeTick = React.memo(function EdgeTick({ dir }: { dir: 'n' | 's' | 'e' | 'w' }) {
  const half = EDGE_TICK_LEN_PX / 2;
  // n/s ticks lie along the horizontal border; e/w along the vertical border.
  const points = dir === 'n' || dir === 's'
    ? `0,${half} ${EDGE_TICK_LEN_PX},${half}`
    : `${half},0 ${half},${EDGE_TICK_LEN_PX}`;
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: EDGE_TICK_LEN_PX,
        height: EDGE_TICK_LEN_PX,
        pointerEvents: 'none',
        overflow: 'visible',
        // Center inside the (larger) hit zone whose own centre sits on the
        // border midpoint — the tick must land on the border, not at the hit
        // zone's top-left corner.
        transform: 'translate(-50%, -50%) scale(var(--box-corner-scale, 1))',
        transformOrigin: '50% 50%',
      }}
    >
      <svg
        width={EDGE_TICK_LEN_PX}
        height={EDGE_TICK_LEN_PX}
        viewBox={`0 0 ${EDGE_TICK_LEN_PX} ${EDGE_TICK_LEN_PX}`}
        style={{ width: '100%', height: '100%', display: 'block', overflow: 'visible' }}
      >
        <polyline points={points} fill="none" stroke="#000000" strokeWidth={EDGE_TICK_STROKE_W + 2} strokeLinecap="square" />
        <polyline points={points} fill="none" stroke="#ffffff" strokeWidth={EDGE_TICK_STROKE_W} strokeLinecap="square" />
      </svg>
    </div>
  );
});

/**
 * PreEditFrame: the text tool's self-drawn pre-edit frame over the ACTIVE text
 * layer (LayerOverlay draws no text gizmos — the old usage/gizmoTypes channel
 * has been removed along with the whole LayerOverlay usage registry).
 *
 * The frame is dual-purpose, crop-mark style:
 *  - 4 corner brackets (BoxCorners, same visual as the editing state) whose
 *    invisible hit zones are diagonal resize handles (`data-gizmo-handle`);
 *  - 4 edge ticks straddling the border midpoints, whose hit zones are
 *    single-axis resize handles;
 *  - an independent rotation handle above the top edge (`data-gizmo-rotate`),
 *    same mechanism and gesture (free rotate, Shift snaps 15°) as before.
 *
 * Interaction contract with the interaction handlers is unchanged: handles
 * carry the same data attributes they had inside LayerOverlayItem, and the
 * frame box itself carries `data-overlay-gizmo-layer={layer.id}` so
 * resolveGizmoTargetLayer keeps resolving the owning layer. Position/size is
 * maintained outside React by usePreEditFrameSync (60fps camera + live-resize
 * following), like MarkerSelectionBox.
 *
 * Display scope: the ACTIVE layer gets the full interactive frame (corner
 * brackets with resize hit zones, edge ticks, rotation handle). Every OTHER
 * visible text layer gets a visual-only corner bracket ghost (no hit zones,
 * no interaction) so all text boxes read as text at a glance — the same
 * "this is a text box" cue the active frame gives, minus the affordance.
 */
export const PreEditFrame = React.memo(function PreEditFrame() {
  const { activeFrame, activeCraft, editingLayerId } = useTextOverlayGate();
  const { geometry } = useEditorServices();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);

  const activeLayer: Layer | null = activeFrame?.activeLayerId
    ? activeFrame.layers.byId[activeFrame.activeLayerId] ?? null
    : null;
  const isText = !!activeLayer && activeLayer.type === 'text' && !!activeLayer.textData && activeLayer.visible;
  const layerId = isText ? activeLayer!.id : null;

  usePreEditFrameSync(boxRef, layerId);
  useOverlayRotationSync(containerRef, activeFrame);

  if (!activeFrame || activeCraft !== 'text' || editingLayerId) return null;

  const layer = activeLayer;
  // Handle cursors only render inside the guarded active-frame block, where
  // the layer is guaranteed present — default to 0° for the type-checker.
  const rotation = layer?.rotation ?? 0;
  const flip = layer?.flip;

  // Visual-only ghosts: every other visible text layer shows plain corner
  // brackets (no hit zones — nothing interactive, pure affordance cue).
  const ghostLayers = activeFrame.layers.order
    .map((id) => activeFrame.layers.byId[id])
    .filter(
      (l): l is Layer =>
        !!l && l.type === 'text' && !!l.textData && l.visible && l.id !== layerId,
    );

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none overflow-visible"
      // Above the whole LayerOverlay stack (its active item sits at zIndex 10
      // inside its own container) so the frame and handles are never painted
      // under the hover outlines / index labels.
      style={{ zIndex: 20 }}
    >
      {ghostLayers.map((ghost) => (
        <PreEditGhost key={ghost.id} layerId={ghost.id} />
      ))}

      {!layerId ? null : (
      <div
        ref={boxRef}
        data-overlay-gizmo-layer={layerId}
        className="absolute top-0 left-0"
        style={{ display: 'none', transformOrigin: '0 0', willChange: 'transform, width, height' }}
      >
        {/* Corner brackets: the border visual. Their hit zones are the diagonal
            resize handles — the bracket IS the handle. */}
        <BoxCorners />

        {/* Corner hit zones (invisible; cursor carries the direction cue) */}
        {CORNER_HANDLES.map(({ dir, angle, style }) => (
          <div
            key={dir}
            data-gizmo-handle={dir}
            className="absolute pointer-events-auto"
            style={{
              width: CORNER_HIT_PX,
              height: CORNER_HIT_PX,
              cursor: cursorForScreenAngle(geometry.transform.poseScreenAngle(angle, rotation, flip)),
              transform: 'translate(-50%, -50%)',
              ...style,
            }}
          />
        ))}

        {/* Edge hit zones with the visible tick straddling the border */}
        {EDGE_HANDLES.map(({ dir, angle, style }) => (
          <div
            key={dir}
            data-gizmo-handle={dir}
            className="absolute pointer-events-auto"
            style={{
              width: dir === 'n' || dir === 's' ? EDGE_HIT_LONG_PX : EDGE_HIT_SHORT_PX,
              height: dir === 'n' || dir === 's' ? EDGE_HIT_SHORT_PX : EDGE_HIT_LONG_PX,
              cursor: cursorForScreenAngle(geometry.transform.poseScreenAngle(angle, rotation, flip)),
              transform: 'translate(-50%, -50%)',
              ...style,
            }}
          >
            <EdgeTick dir={dir} />
          </div>
        ))}

        {/* Rotation handle: dot floating above the top edge (screen px — the
            frame box carries no camera scale). Same black-underlay + white-core
            dual stroke as the corner brackets, on a circular path. */}
        <div
          data-gizmo-rotate="true"
          className="pointer-events-auto hover:scale-125 transition-transform duration-150"
          style={{
            width: ROTATE_HANDLE_PX,
            height: ROTATE_HANDLE_PX,
            left: '50%',
            top: `${-ROTATE_HANDLE_OFFSET_PX}px`,
            position: 'absolute',
            transform: 'translate(-50%, -50%)',
            cursor: ROTATE_CURSOR,
            overflow: 'visible',
          }}
        >
          <svg
            width={ROTATE_HANDLE_PX}
            height={ROTATE_HANDLE_PX}
            viewBox={`0 0 ${ROTATE_HANDLE_PX} ${ROTATE_HANDLE_PX}`}
            style={{ width: '100%', height: '100%', display: 'block', overflow: 'visible' }}
          >
            <circle
              cx={ROTATE_HANDLE_PX / 2}
              cy={ROTATE_HANDLE_PX / 2}
              r={ROTATE_HANDLE_PX / 2 - EDGE_TICK_STROKE_W}
              fill="#ffffff"
              stroke="#000000"
              strokeWidth={EDGE_TICK_STROKE_W + 2}
            />
            <circle
              cx={ROTATE_HANDLE_PX / 2}
              cy={ROTATE_HANDLE_PX / 2}
              r={ROTATE_HANDLE_PX / 2 - EDGE_TICK_STROKE_W}
              fill="none"
              stroke="#ffffff"
              strokeWidth={EDGE_TICK_STROKE_W}
            />
          </svg>
        </div>
      </div>
      )}
    </div>
  );
});

/**
 * PreEditGhost: visual-only corner brackets over a NON-active text layer.
 * No hit zones, no handles — the ghost is pure affordance ("this is a text
 * box"), so it must never intercept a click meant for the canvas beneath
 * (selection / creation). Camera+pose following reuses usePreEditFrameSync
 * with its own box ref, one fast-sync subscription per ghost.
 */
function PreEditGhost({ layerId }: { layerId: string }) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  usePreEditFrameSync(boxRef, layerId);
  return (
    <div
      ref={boxRef}
      data-text-preedit-ghost={layerId}
      className="absolute top-0 left-0 pointer-events-none"
      style={{ display: 'none', transformOrigin: '0 0', willChange: 'transform, width, height' }}
    >
      <BoxCorners />
    </div>
  );
}

/**
 * Narrow state gate for the pre-edit frame: reads the same signals as
 * useTextOverlayState but without its cursor/hover side effects, so mounting
 * the frame stays side-effect free.
 */
function useTextOverlayGate() {
  const { state, activeFrame } = useEditorState();
  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft] as string | null;
  const editingLayerId = state.interaction.signals[TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID] as string | null;
  return { activeFrame, activeCraft, editingLayerId };
}
