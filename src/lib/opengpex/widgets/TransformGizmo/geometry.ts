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

import type { CSSProperties } from 'react';

/**
 * Outset of every knob (bracket / cube / chip / edge tick) from the box edges,
 * in screen px. Matches the LayerOverlay hover outline's -inset-x-[6px]
 * -inset-y-[4px] so knobs and that outline all sit on the same line.
 */
export const KNOB_OUTSET_X_PX = 6;
export const KNOB_OUTSET_Y_PX = 4;

/**
 * The 8 transform-gizmo handle directions (4 corners + 4 edge midpoints).
 *
 * Kept as a self-contained union so this widget stays decoupled from the
 * stage/interaction layer; the string values are structurally identical to
 * `ResizeHandle` (stage/interaction/handlers/TransformHandler), which is what a
 * consuming plugin reads back from the `data-gizmo-handle` attribute.
 */
export type GizmoHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

/** The diagonal (corner) subset of GizmoHandle. */
export type CornerDir = 'nw' | 'ne' | 'sw' | 'se';

/** The single-axis (edge midpoint) subset of GizmoHandle. */
export type EdgeDir = 'n' | 's' | 'e' | 'w';

/**
 * One handle anchor: its direction (written verbatim into `data-gizmo-handle`),
 * the handle's outward normal in the layer's LOCAL space (screen convention,
 * 0° = +x / east, clockwise because screen +y points down — used to pick a
 * rotation-correct cursor since CSS cursors ignore CSS `transform`), and the
 * CSS top/left of the handle's centre on the frame box. Every consumer pairs
 * the anchor with `translate(-50%, -50%)` so the mark is centred on the point
 * regardless of its pixel size.
 */
export interface HandleAnchor<D extends GizmoHandle = GizmoHandle> {
  readonly dir: D;
  readonly angle: number;
  readonly style: CSSProperties;
}

/**
 * Outset edge positions (CSS lengths). Every anchor sits on the OUTLINE line —
 * the bounding rect pushed outward by the same 6/4 px BoxCorners uses, which is
 * also where LayerOverlay draws its hover outline — so marks of every variant
 * ride on that line instead of sitting inside it. Counter-scaled through
 * `--box-corner-scale` so the outset stays a screen distance when the host box
 * carries a camera scale.
 */
const OUT_TOP = `calc(-1 * var(--box-corner-scale, 1) * ${KNOB_OUTSET_Y_PX}px)`;
const OUT_BOTTOM = `calc(100% + var(--box-corner-scale, 1) * ${KNOB_OUTSET_Y_PX}px)`;
const OUT_LEFT = `calc(-1 * var(--box-corner-scale, 1) * ${KNOB_OUTSET_X_PX}px)`;
const OUT_RIGHT = `calc(100% + var(--box-corner-scale, 1) * ${KNOB_OUTSET_X_PX}px)`;

/** The 4 corner anchors, on the outline's corners. */
export const CORNER_ANCHORS: readonly HandleAnchor<CornerDir>[] = [
  { dir: 'nw', angle: 225, style: { top: OUT_TOP, left: OUT_LEFT } },
  { dir: 'ne', angle: 315, style: { top: OUT_TOP, left: OUT_RIGHT } },
  { dir: 'sw', angle: 135, style: { top: OUT_BOTTOM, left: OUT_LEFT } },
  { dir: 'se', angle: 45, style: { top: OUT_BOTTOM, left: OUT_RIGHT } },
];

/** The 4 edge anchors, on the outline's edge midpoints. */
export const EDGE_ANCHORS: readonly HandleAnchor<EdgeDir>[] = [
  { dir: 'n', angle: 270, style: { top: OUT_TOP, left: '50%' } },
  { dir: 's', angle: 90, style: { top: OUT_BOTTOM, left: '50%' } },
  { dir: 'w', angle: 180, style: { top: '50%', left: OUT_LEFT } },
  { dir: 'e', angle: 0, style: { top: '50%', left: OUT_RIGHT } },
];

/** Stroke width of the white core in every dual-stroke mark (screen px). */
export const MARK_STROKE_W = 2;

/**
 * Wrapper style shared by every point mark (cube / chip / edge tick / rotate
 * dot): an absolutely positioned square of `sizePx`, centred on `anchor`
 * (default: the centre of its parent), counter-scaled through
 * `--box-corner-scale` so it stays screen-constant when the host box carries a
 * camera scale (default 1 = already screen px).
 */
export function markBoxStyle(
  sizePx: number,
  anchor: CSSProperties = { left: '50%', top: '50%' },
): CSSProperties {
  return {
    position: 'absolute',
    width: sizePx,
    height: sizePx,
    pointerEvents: 'none',
    overflow: 'visible',
    transform: 'translate(-50%, -50%) scale(var(--box-corner-scale, 1))',
    transformOrigin: '50% 50%',
    ...anchor,
  };
}
