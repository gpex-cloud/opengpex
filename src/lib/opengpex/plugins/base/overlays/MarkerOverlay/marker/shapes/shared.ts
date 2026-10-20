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

/**
 * Helpers shared by several shapes' definitions and render modules: Shift 45°
 * snapping and the padded bounding box for the two-endpoint family (arrow /
 * line / darrow), the arrowhead SVG fragment, corner-radius clamping and the
 * SVG paint attribute strings. Render-side: this module must stay free of React
 * (checked by render-purity.test.ts).
 */

import type { MarkerData } from '../types';
import { toCssColor4 } from '@opengpex/editor/core/engine/color';

/** 45° angle snap step (radians) applied when Shift is held. */
const SNAP_STEP = Math.PI / 4;

/** Snap the end point's direction (from start) to the nearest 45°, preserving length. */
export function snapDirection45(startX: number, startY: number, endX: number, endY: number): { x: number; y: number } {
  const dx = endX - startX;
  const dy = endY - startY;
  const len = Math.hypot(dx, dy);
  const snapped = Math.round(Math.atan2(dy, dx) / SNAP_STEP) * SNAP_STEP;
  return { x: startX + Math.cos(snapped) * len, y: startY + Math.sin(snapped) * len };
}

/**
 * Bounding box of two canvas-local points padded by `pad` on every side, plus the
 * two points re-expressed relative to that box's top-left (layer-local).
 */
export function segmentBounding(
  start: { x: number; y: number },
  end: { x: number; y: number },
  pad: number,
): {
  bounding: { w: number; h: number };
  centerLocal: { x: number; y: number };
  a: { x: number; y: number };
  b: { x: number; y: number };
} {
  const minX = Math.min(start.x, end.x) - pad;
  const minY = Math.min(start.y, end.y) - pad;
  const maxX = Math.max(start.x, end.x) + pad;
  const maxY = Math.max(start.y, end.y) + pad;
  const w = maxX - minX;
  const h = maxY - minY;
  return {
    bounding: { w, h },
    centerLocal: { x: minX + w / 2, y: minY + h / 2 },
    a: { x: start.x - minX, y: start.y - minY },
    b: { x: end.x - minX, y: end.y - minY },
  };
}

/**
 * SVG arrowhead triangle with its apex at `tip`, pointing along `angle`
 * (radians, the direction from shaft toward tip), `headLen` long and half as
 * wide. Returns the shaft-side base centre (so the caller can clip the shaft
 * back to it) and the polygon fragment.
 */
export function arrowHeadSvg(
  tip: { x: number; y: number },
  angle: number,
  headLen: number,
  color: string,
): { base: { x: number; y: number }; polygon: string } {
  const headHalfW = headLen * 0.5;
  const base = { x: tip.x - Math.cos(angle) * headLen, y: tip.y - Math.sin(angle) * headLen };
  const perpX = -Math.sin(angle) * headHalfW;
  const perpY = Math.cos(angle) * headHalfW;
  const points = `${tip.x},${tip.y} ${base.x + perpX},${base.y + perpY} ${base.x - perpX},${base.y - perpY}`;
  return { base, polygon: `<polygon points="${points}" fill="${color}" />` };
}

/** Corner radius clamped to half the short side (a fuller round cannot exist). */
export function clampRadius(radius: number, w: number, h: number): number {
  const max = Math.min(w, h) / 2;
  return Math.max(0, Math.min(radius || 0, max));
}

/** SVG `fill` / `fill-opacity` attribute values for a marker's fill ("none" when off). */
export function svgFillAttrs(data: MarkerData): string {
  const on = data.fill.opacity > 0;
  const fill = on ? toCssColor4(data.fill.color) : 'none';
  return `fill="${fill}" fill-opacity="${on ? data.fill.opacity : 0}"`;
}

/** SVG stroke colour attribute value. */
export function svgStroke(data: MarkerData): string {
  return toCssColor4(data.stroke.color);
}
