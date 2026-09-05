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

import React, { CSSProperties } from 'react';

/**
 * The 8 transform-gizmo handle directions (4 corners + 4 edge midpoints).
 *
 * Kept as a self-contained union so this widget stays decoupled from the
 * stage/interaction layer; the string values are structurally identical to
 * `ResizeHandle` (stage/interaction/handlers/TransformHandler), which is what a
 * consuming plugin reads back from the `data-gizmo-handle` attribute.
 */
export type GizmoHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

/** A single handle: its direction, local outward-normal angle, and CSS anchor. */
interface GizmoHandleDef {
  /** Handle direction, written verbatim into `data-gizmo-handle`. */
  readonly h: GizmoHandle;
  /**
   * The handle's outward normal in the layer's LOCAL space, measured in screen
   * convention (0° = +x / east, growing clockwise because screen +y points
   * down). Used to pick a rotation-correct cursor: CSS cursors are not affected
   * by CSS `transform`, so a rotated selection box would otherwise keep showing
   * the unrotated (canvas-axis) arrows.
   */
  readonly angle: number;
  /**
   * Position of the handle's centre on the box border, as top/left percentages.
   * Paired with `translate(-50%, -50%)` so the dot is centred on the corner/edge
   * point regardless of its pixel size.
   */
  readonly style: CSSProperties;
}

/**
 * Shared 8-handle geometry for the transform gizmo (text + marker).
 *
 * Positions are expressed as top/left percentages of the box and centred via a
 * `translate(-50%, -50%)` below; this is pixel-identical to the earlier
 * per-overlay `-half` margin offsets while remaining agnostic to the handle's
 * pixel size (constant screen size vs. counter-scaled).
 */
const HANDLE_GEOMETRY: readonly GizmoHandleDef[] = [
  // Corners
  { h: 'nw', angle: 225, style: { top: 0, left: 0 } },
  { h: 'ne', angle: 315, style: { top: 0, left: '100%' } },
  { h: 'sw', angle: 135, style: { top: '100%', left: 0 } },
  { h: 'se', angle: 45, style: { top: '100%', left: '100%' } },
  // Edges
  { h: 'n', angle: 270, style: { top: 0, left: '50%' } },
  { h: 's', angle: 90, style: { top: '100%', left: '50%' } },
  { h: 'w', angle: 180, style: { top: '50%', left: 0 } },
  { h: 'e', angle: 0, style: { top: '50%', left: '100%' } },
] as const;

/**
 * Map an on-screen direction (degrees) to the nearest of the 4 resize cursors.
 *
 * Cursors are bidirectional, so the direction is folded into [0,180) and then
 * bucketed every 45°: e/w → `ew-resize`, ne/sw → `nesw-resize`,
 * n/s → `ns-resize`, nw/se → `nwse-resize`.
 */
function cursorForAngle(angleDeg: number): string {
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
 * Resolve a handle's cursor for the layer's current pose.
 *
 * The selection box is drawn through the layer's full world matrix (see each
 * overlay's pose-sync), so after a canvas Rotate Left/Right the box self-rotates
 * — but CSS `cursor` keywords ignore CSS `transform`. We therefore rotate the
 * handle's local outward normal by `layer.rotation` (mirroring flips first,
 * matching the renderer's R × F convention) and pick the matching cursor.
 */
function resolveHandleCursor(
  angle: number,
  rotation: number,
  flip: { h: boolean; v: boolean } | undefined
): string {
  // Mirror the direction vector before rotating (F then R, as in getOrientationMatrix).
  const rad = (angle * Math.PI) / 180;
  let dx = Math.cos(rad);
  let dy = Math.sin(rad);
  if (flip?.h) dx = -dx;
  if (flip?.v) dy = -dy;

  const screenAngle = (Math.atan2(dy, dx) * 180) / Math.PI + rotation;
  return cursorForAngle(screenAngle);
}

export interface TransformGizmoProps {
  /**
   * The layer's rotation (degrees) — used only to pick rotation-correct handle
   * cursors (the box itself is rotated by the consumer's CSS matrix).
   */
  rotation: number;
  /** The layer's mirror flags, applied before rotation when resolving cursors. */
  flip: { h: boolean; v: boolean } | undefined;
  /**
   * Handle dot size in the box's own CSS units. Consumers pass a constant
   * screen-space value (e.g. `10`) when the box carries no scale, or a
   * counter-scaled value (e.g. `10 / cameraK`) when the box is rendered through
   * the full camera scale — either way the dot ends up ~10px on screen.
   */
  handleSizePx: number;
  /** Extra classes for each handle dot (e.g. border colour). */
  handleClassName?: string;
  /** Render the 1px selection outline (marker); text supplies its own border. */
  showOutline?: boolean;
  /** Extra classes for the outline element (e.g. border colour/opacity). */
  outlineClassName?: string;
  /**
   * Pointer-down handler for each handle (e.g. text's `preventDefault` to keep
   * the contenteditable from losing focus). Omitted for marker.
   */
  onHandlePointerDown?: (e: React.MouseEvent) => void;
}

/**
 * TransformGizmo: the shared selection-box control layer for text + marker.
 *
 * Renders an optional 1px outline plus the 8 resize handles (4 corners + 4 edge
 * midpoints) inside an `absolute inset-0 pointer-events-none` wrapper, so it can
 * drop straight into either overlay's pose-synced box without altering the DOM
 * structure. Each handle:
 *  - carries `data-gizmo-handle=<dir>` which the plugins' resize handlers detect;
 *  - is `pointer-events-auto` while the wrapper/outline stay non-interactive, so
 *    the box never blocks move/draw/text-edit on the shape body;
 *  - is centred on its corner/edge point via `translate(-50%, -50%)` (composes
 *    with the Tailwind `hover:scale-125` `scale` property under Tailwind v4);
 *  - gets a rotation-aware cursor recomputed from its LOCAL outward-normal angle
 *    plus the layer's rotation/flip (CSS cursor keywords ignore `transform`).
 *
 * This component is purely presentational: it owns no state and no pose sync —
 * the marker/text overlays keep their own fast-sync hooks (their scale handling
 * differs by design: constant-size box vs. WYSIWYG camera-scaled contenteditable).
 */
export const TransformGizmo = React.memo(function TransformGizmo({
  rotation,
  flip,
  handleSizePx,
  handleClassName = '',
  showOutline = false,
  outlineClassName = '',
  onHandlePointerDown,
}: TransformGizmoProps) {
  return (
    <div className="absolute inset-0 pointer-events-none">
      {showOutline && (
        <div className={`absolute -inset-[1px] border ${outlineClassName}`} />
      )}

      {HANDLE_GEOMETRY.map(({ h, angle, style }) => (
        <div
          key={h}
          data-gizmo-handle={h}
          onMouseDown={onHandlePointerDown}
          className={`absolute rounded-full bg-white shadow-sm pointer-events-auto hover:scale-125 transition-transform duration-150 ${handleClassName}`}
          style={{
            width: `${handleSizePx}px`,
            height: `${handleSizePx}px`,
            cursor: resolveHandleCursor(angle, rotation, flip),
            transform: 'translate(-50%, -50%)',
            ...style,
          }}
        />
      ))}
    </div>
  );
});
