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
import { poseScreenAngle } from '@opengpex/editor/core/geometry/operators/rotator';
import { ROTATE_CURSOR } from '@opengpex/editor/icons';
import { BoxCorners } from './knobs/BoxCorners';
import { BoxCube } from './knobs/BoxCube';
import { BoxChip } from './knobs/BoxChip';
import {
  CORNER_ANCHORS,
  EDGE_ANCHORS,
  MARK_STROKE_W,
  markBoxStyle,
  type EdgeDir,
} from './geometry';

export { BoxCorners, type BoxCornersProps } from './knobs/BoxCorners';
export { BoxCube } from './knobs/BoxCube';
export { BoxChip } from './knobs/BoxChip';
export { KNOB_OUTSET_X_PX, KNOB_OUTSET_Y_PX, type GizmoHandle, type CornerDir, type EdgeDir } from './geometry';

// ─── Sizing constants (screen px; the frame box carries no camera scale) ──────

/** Hit-zone side for the corner handles (invisible, centred on each corner). */
const CORNER_HIT_PX = 18;

/** Hit-zone size for the edge handles: elongated along the edge for easy grab. */
const EDGE_HIT_LONG_PX = 24;
const EDGE_HIT_SHORT_PX = 14;

/** Visible edge tick length (corner variant only). */
const EDGE_TICK_LEN_PX = 12;

/** Opacity of a dimmed (non-selected sibling) ghost frame. */
const GHOST_DIM_OPACITY = 0.45;

/** Rotation handle dot size and distance above the top edge (screen px). */
const ROTATE_HANDLE_PX = 10;
const ROTATE_HANDLE_OFFSET_PX = 24;

/**
 * Map an on-screen direction (degrees) to the nearest of the 4 resize cursors.
 *
 * Cursors are bidirectional, so the direction is folded into [0,180) and then
 * bucketed every 45°: e/w → `ew-resize`, ne/sw → `nesw-resize`,
 * n/s → `ns-resize`, nw/se → `nwse-resize`.
 *
 * Pure UI vocabulary: the angle math (direction under flip + rotation) lives
 * in `poseScreenAngle` (core/geometry/operators/rotator.ts) — compose the
 * two for pose-aware handle cursors.
 */
export function cursorForScreenAngle(angleDeg: number): string {
  const a = ((angleDeg % 180) + 180) % 180;
  const bucket = Math.round(a / 45) % 4;
  switch (bucket) {
    case 0: return 'ew-resize';
    case 1: return 'nwse-resize';   // pointing down-right (screen +y is down)
    case 2: return 'ns-resize';
    default: return 'nesw-resize';  // pointing up-right
  }
}

/**
 * EdgeTick: a short mark lying ALONG the border at an edge midpoint — the
 * visible half of the edge handle in the corner-bracket variant (n/s →
 * horizontal bar on the top/bottom border, e/w → vertical bar on the left/right
 * border). Same black-underlay + white-core dual stroke as BoxCorners. Centred
 * inside the (larger) hit zone whose own centre sits on the border midpoint,
 * so the tick lands on the border rather than at the hit zone's top-left.
 */
const EdgeTick = React.memo(function EdgeTick({ dir }: { dir: EdgeDir }) {
  const half = EDGE_TICK_LEN_PX / 2;
  // n/s ticks lie along the horizontal border; e/w along the vertical border.
  const points = dir === 'n' || dir === 's'
    ? `0,${half} ${EDGE_TICK_LEN_PX},${half}`
    : `${half},0 ${half},${EDGE_TICK_LEN_PX}`;
  return (
    <div style={markBoxStyle(EDGE_TICK_LEN_PX)}>
      <svg
        width={EDGE_TICK_LEN_PX}
        height={EDGE_TICK_LEN_PX}
        viewBox={`0 0 ${EDGE_TICK_LEN_PX} ${EDGE_TICK_LEN_PX}`}
        style={{ width: '100%', height: '100%', display: 'block', overflow: 'visible' }}
      >
        <polyline points={points} fill="none" stroke="#000000" strokeWidth={MARK_STROKE_W + 2} strokeLinecap="square" />
        <polyline points={points} fill="none" stroke="#ffffff" strokeWidth={MARK_STROKE_W} strokeLinecap="square" />
      </svg>
    </div>
  );
});

/**
 * Handle look. All three ride on the same outset outline line (KNOB_OUTSET,
 * shared with the LayerOverlay hover outline), so switching variant never
 * moves the hit zones:
 *  - `corner` — crop-mark style: 4 corner brackets + 4 edge ticks (BoxCorners + EdgeTick);
 *  - `cube`   — 8 small squares (BoxCube);
 *  - `chip`   — 8 small discs (BoxChip).
 * The rotation handle is identical across variants.
 */
export type TransformGizmoVariant = 'corner' | 'cube' | 'chip';

export interface TransformGizmoProps {
  /**
   * The layer's rotation (degrees) — used only to pick rotation-correct handle
   * cursors (the box itself is rotated by the consumer's CSS matrix). Ignored
   * in `visualOnly` mode, where no handles exist; defaults to 0.
   */
  rotation?: number;
  /**
   * The layer's mirror flags, applied before rotation when resolving cursors.
   * Ignored in `visualOnly` mode.
   */
  flip?: { h: boolean; v: boolean };
  /** Handle look; defaults to the crop-mark `corner` style. */
  variant?: TransformGizmoVariant;
  /**
   * Visual-only mode: render just the variant's marks with no hit zones and
   * no rotation handle. Used wherever the frame is a pure "this is a box"
   * cue that must never intercept clicks: affordance ghosts over non-active
   * layers, and the text editing state (no resize/rotate while typing).
   */
  visualOnly?: boolean;
  /**
   * Render the marks at reduced opacity. Used for affordance ghosts over layers
   * that are NOT the current selection, so a selected-but-detached frame (full
   * opacity ghost) still reads as "the selection" among its dimmed siblings.
   */
  dimmed?: boolean;
}

/**
 * TransformGizmo: the shared selection control for overlay layers (text,
 * marker), rendered as high-contrast black/white dual-stroke marks instead of
 * solid accent-colored dots.
 *
 * Renders inside an `absolute inset-0 pointer-events-none` wrapper so it can
 * drop straight into any overlay's pose-synced box without altering the DOM
 * structure. The visual marks (BoxCorners / BoxCube / BoxChip) are pure
 * decoration; interaction comes from invisible hit zones centred on the same
 * anchors — the mark IS the handle, visually:
 *  - 4 corner hit zones: diagonal resize, `data-gizmo-handle=<nw|ne|sw|se>`;
 *  - 4 edge hit zones: single-axis resize, `data-gizmo-handle=<n|s|e|w>`;
 *  - a rotation handle dot above the top edge, `data-gizmo-rotate`.
 *
 * Each hit zone is `pointer-events-auto` while the wrapper stays
 * non-interactive, so the box never blocks move/draw on the layer body, and
 * gets a rotation-aware cursor recomputed from its LOCAL outward-normal angle
 * plus the layer's rotation/flip (CSS cursor keywords ignore CSS `transform`).
 *
 * Purely presentational: owns no state and no pose sync — consuming overlays
 * keep their own fast-sync hooks. The frame box is expected to be screen-space
 * constant-size (the consumer's fast-sync writes screen coordinates), so no
 * counter-scaling is applied here beyond the `--box-corner-scale` variable the
 * marks honour (default 1).
 */
export const TransformGizmo = React.memo(function TransformGizmo({
  rotation = 0,
  flip,
  variant = 'corner',
  visualOnly = false,
  dimmed = false,
}: TransformGizmoProps) {
  const marks =
    variant === 'cube' ? <BoxCube /> :
    variant === 'chip' ? <BoxChip /> :
    <BoxCorners />;
  const wrapperStyle: React.CSSProperties | undefined = dimmed ? { opacity: GHOST_DIM_OPACITY } : undefined;

  if (visualOnly) {
    return <div className="absolute inset-0 pointer-events-none" style={wrapperStyle}>{marks}</div>;
  }

  return (
    <div className="absolute inset-0 pointer-events-none" style={wrapperStyle}>
      {marks}

      {/* Corner hit zones (invisible; cursor carries the direction cue) */}
      {CORNER_ANCHORS.map(({ dir, angle, style }) => (
        <div
          key={dir}
          data-gizmo-handle={dir}
          className="absolute pointer-events-auto"
          style={{
            width: CORNER_HIT_PX,
            height: CORNER_HIT_PX,
            cursor: cursorForScreenAngle(poseScreenAngle(angle, rotation, flip)),
            transform: 'translate(-50%, -50%)',
            ...style,
          }}
        />
      ))}

      {/* Edge hit zones; the corner variant draws its tick inside the zone */}
      {EDGE_ANCHORS.map(({ dir, angle, style }) => (
        <div
          key={dir}
          data-gizmo-handle={dir}
          className="absolute pointer-events-auto"
          style={{
            width: dir === 'n' || dir === 's' ? EDGE_HIT_LONG_PX : EDGE_HIT_SHORT_PX,
            height: dir === 'n' || dir === 's' ? EDGE_HIT_SHORT_PX : EDGE_HIT_LONG_PX,
            cursor: cursorForScreenAngle(poseScreenAngle(angle, rotation, flip)),
            transform: 'translate(-50%, -50%)',
            ...style,
          }}
        >
          {variant === 'corner' && <EdgeTick dir={dir} />}
        </div>
      ))}

      {/* Rotation handle: dot floating above the top edge (screen px — the
          frame box carries no camera scale). Same black-underlay + white-core
          dual stroke as the marks, on a circular path. */}
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
            r={ROTATE_HANDLE_PX / 2 - MARK_STROKE_W}
            fill="#ffffff"
            stroke="#000000"
            strokeWidth={MARK_STROKE_W + 2}
          />
          <circle
            cx={ROTATE_HANDLE_PX / 2}
            cy={ROTATE_HANDLE_PX / 2}
            r={ROTATE_HANDLE_PX / 2 - MARK_STROKE_W}
            fill="none"
            stroke="#ffffff"
            strokeWidth={MARK_STROKE_W}
          />
        </svg>
      </div>
    </div>
  );
});
