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

import React, { useContext, useEffect, useRef } from 'react';
import { poseScreenAngle } from '@opengpex/editor/core/geometry/operators/rotator';
import { ROTATE_CURSOR } from '@opengpex/editor/icons';
import { EditorServiceContext } from '@opengpex/editor/core/context';
import { BoxCorners } from './knobs/BoxCorners';
import { BoxCube } from './knobs/BoxCube';
import { BoxChip } from './knobs/BoxChip';
import {
  CORNER_ANCHORS,
  EDGE_ANCHORS,
  MARK_STROKE_W,
} from './geometry';

export { BoxCorners, type BoxCornersProps } from './knobs/BoxCorners';
export { BoxCube } from './knobs/BoxCube';
export { BoxChip } from './knobs/BoxChip';
export { KNOB_OUTSET_X_PX, KNOB_OUTSET_Y_PX, type GizmoHandle, type CornerDir, type EdgeDir } from './geometry';

// ─── Sizing constants (screen px; the frame box carries no camera scale) ──────

/** Hit-zone side for the corner handles (invisible, centred on each corner). */
const CORNER_HIT_PX = 18;

/** Thickness of the full-edge resize strips rendered in `outline` mode. */
const OUTLINE_EDGE_HIT_PX = 12;

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
 * Handle look. All three ride on the same outset outline line (KNOB_OUTSET,
 * shared with the LayerOverlay hover outline), so switching variant never
 * moves the hit zones:
 *  - `corner` — crop-mark style: 4 corner brackets (BoxCorners);
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
  /**
   * Full-edge hit mode (selection frames): renders FULL-LENGTH edge strips
   * instead of the retired short edge-midpoint zones, so any point on the
   * border — not just the edge midpoint — starts a single-axis resize.
   * Purely an interaction affordance: renders no outline visuals of its own.
   * Corner handles keep priority at the corners (rendered after the strips).
   */
  outline?: boolean;
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
 *  - in `outline` mode, 4 full-length edge strips: single-axis resize,
 *    `data-gizmo-handle=<n|s|e|w>` (no extra visuals — strips are invisible);
 *  - a rotation handle dot above the top edge, `data-gizmo-rotate`.
 *
 * Each hit zone is `pointer-events-auto` while the wrapper stays
 * non-interactive, so the box never blocks move/draw on the layer body. Hit
 * zones NEVER write a CSS cursor: every zone carries its pose-resolved value
 * in `data-gizmo-cursor`, and the internal pointermove sync feeds it into the
 * CursorService hover channel — the single resolver for the viewport pointer
 * cursor (CSS cursors ignore CSS `transform` anyway, so the pose math that
 * produced the attribute value is unchanged).
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
  outline = false,
}: TransformGizmoProps) {
  const marks =
    variant === 'cube' ? <BoxCube /> :
    variant === 'chip' ? <BoxChip /> :
    <BoxCorners />;
  const wrapperStyle: React.CSSProperties | undefined = dimmed ? { opacity: GHOST_DIM_OPACITY } : undefined;

  // ─── CursorService sync ─────────────────────────────────────────────────
  // Hit zones carry their pose-resolved cursor in `data-gizmo-cursor`; this
  // document-level pass feeds it into the CursorService hover channel so the
  // single resolver owns the viewport pointer cursor (no CSS cursor writes).
  // Multiple gizmo instances coexist (active + ghost marks), so an instance
  // only clears the hover it previously claimed — ghosts without hit zones
  // never match and never stomp another instance's declaration.
  const rootRef = useRef<HTMLDivElement>(null);
  // Read the service context directly (not via useEditorServices) so the
  // widget degrades gracefully when rendered outside an EditorProvider
  // (standalone stories/tests): without a store there is no CursorService to
  // feed, and the sync simply never registers.
  const services = useContext(EditorServiceContext);
  const notifyHover = services?.actions.fast.cursor.notifyHover;
  const ownsHoverRef = useRef(false);

  useEffect(() => {
    if (!notifyHover) return;
    const onPointerMove = (ev: PointerEvent) => {
      const el = ev.target as HTMLElement | null;
      const zone = el?.closest?.('[data-gizmo-cursor]');
      if (zone && rootRef.current?.contains(zone)) {
        notifyHover(zone.getAttribute('data-gizmo-cursor'));
        ownsHoverRef.current = true;
      } else if (ownsHoverRef.current) {
        notifyHover(null);
        ownsHoverRef.current = false;
      }
    };
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      if (ownsHoverRef.current) {
        notifyHover(null);
        ownsHoverRef.current = false;
      }
    };
  }, [notifyHover]);

  if (visualOnly) {
    return <div className="absolute inset-0 pointer-events-none" style={wrapperStyle}>{marks}</div>;
  }

  // Pose-resolved cursor per hit zone (LOCAL outward-normal angle composed
  // with the layer's rotation/flip), written into data-gizmo-cursor.
  const edgeCursor = (angle: number) => cursorForScreenAngle(poseScreenAngle(angle, rotation, flip));

  return (
    <div ref={rootRef} className="absolute inset-0 pointer-events-none" style={wrapperStyle}>
      {marks}

      {/* Full-length edge strips (outline mode only): any point on the border
          starts a single-axis resize. Rendered BEFORE the corner zones so the
          corner handles keep priority where the strips overlap them. The
          strips extend to the box corners so no dead zone remains between
          strip and corner handle. */}
      {outline && EDGE_ANCHORS.map(({ dir, angle, style }) => (
        <div
          key={dir}
          data-gizmo-handle={dir}
          data-gizmo-cursor={edgeCursor(angle)}
          className="absolute pointer-events-auto"
          style={{
            width: dir === 'n' || dir === 's' ? '100%' : OUTLINE_EDGE_HIT_PX,
            height: dir === 'n' || dir === 's' ? OUTLINE_EDGE_HIT_PX : '100%',
            transform: 'translate(-50%, -50%)',
            ...style,
          }}
        />
      ))}

      {/* Corner hit zones (invisible) */}
      {CORNER_ANCHORS.map(({ dir, angle, style }) => (
        <div
          key={dir}
          data-gizmo-handle={dir}
          data-gizmo-cursor={edgeCursor(angle)}
          className="absolute pointer-events-auto"
          style={{
            width: CORNER_HIT_PX,
            height: CORNER_HIT_PX,
            transform: 'translate(-50%, -50%)',
            ...style,
          }}
        />
      ))}

      {/* Rotation handle: dot floating above the top edge (screen px — the
          frame box carries no camera scale). Same black-underlay + white-core
          dual stroke as the marks, on a circular path. */}
      <div
        data-gizmo-rotate="true"
        data-gizmo-cursor={ROTATE_CURSOR}
        className="pointer-events-auto hover:scale-125 transition-transform duration-150"
        style={{
          width: ROTATE_HANDLE_PX,
          height: ROTATE_HANDLE_PX,
          left: '50%',
          top: `${-ROTATE_HANDLE_OFFSET_PX}px`,
          position: 'absolute',
          transform: 'translate(-50%, -50%)',
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
