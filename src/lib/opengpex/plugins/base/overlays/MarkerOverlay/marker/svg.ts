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
 * markerSvg.ts — SVG preview fragments for annotation markers.
 *
 * Markers render on the GPU via the vector spine's analytic SDF strategy (see
 * `core/engine/gpu/shaders/sdf.ts`); this module only provides `markerToSvg`, used
 * by the drag-preview overlay to mirror the on-canvas shape while a marker is being
 * drawn/resized.
 *
 * Colors go out as CSS Color 4 `color()` values, never `.hex` — hex is the lossy
 * clamp+quantize view, so a wide-gamut marker would preview visibly duller
 * mid-drag and snap vivid on commit. Requires an engine that accepts `color()`
 * in SVG presentation attributes (Chromium 111+, Safari 15+); older engines
 * fall back to the initial fill (black).
 *
 * @module plugins/base/overlays/MarkerOverlay/marker/svg
 */

import type { ArrowMarkerData, EllipseMarkerData, MarkerData, RectMarkerData } from './types';
import { toCssColor4 } from '@opengpex/editor/core/engine/color';

/** Minimal bounding contract — accepts both live Layer.bounding and descriptors. */
export interface MarkerBounding {
  w: number;
  h: number;
}

// ─── SVG Rendering ───

/**
 * markerToSvg: build an SVG fragment string for a marker (layer-local origin).
 */
export function markerToSvg(markerData: MarkerData, bounding: MarkerBounding): string {
  switch (markerData.kind) {
    case 'rect':
      return rectToSvg(markerData, bounding);
    case 'arrow':
      return arrowToSvg(markerData);
    case 'ellipse':
      return ellipseToSvg(markerData, bounding);
    default: {
      const _never: never = markerData;
      void _never;
      return '';
    }
  }
}

function rectToSvg(data: RectMarkerData, bounding: MarkerBounding): string {
  const sw = Math.max(0, data.stroke.width);
  const half = sw / 2;
  const w = Math.max(0, bounding.w - sw);
  const h = Math.max(0, bounding.h - sw);
  if (w <= 0 || h <= 0) return '';

  const radius = clampRadius(data.cornerRadius, w, h);
  const fill = data.fill.opacity > 0 ? toCssColor4(data.fill.color) : 'none';
  const fillOpacity = data.fill.opacity > 0 ? data.fill.opacity : 0;

  return (
    `<rect x="${half}" y="${half}" width="${w}" height="${h}" ` +
    `rx="${radius}" ry="${radius}" ` +
    `fill="${fill}" fill-opacity="${fillOpacity}" ` +
    `stroke="${toCssColor4(data.stroke.color)}" stroke-width="${sw}" ` +
    `stroke-linejoin="miter" />`
  );
}

function arrowToSvg(data: ArrowMarkerData): string {
  const sw = Math.max(0, data.stroke.width);
  const { tail, head } = data;

  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const len = Math.hypot(dx, dy);
  if (len <= 0) return '';

  const angle = Math.atan2(dy, dx);
  const headScale = data.headScale || 3;
  const headLen = sw * headScale;
  const headHalfW = headLen * 0.5;

  const shaftEndX = head.x - Math.cos(angle) * headLen;
  const shaftEndY = head.y - Math.sin(angle) * headLen;

  const perpX = -Math.sin(angle) * headHalfW;
  const perpY = Math.cos(angle) * headHalfW;

  const p1 = `${head.x},${head.y}`;
  const p2 = `${shaftEndX + perpX},${shaftEndY + perpY}`;
  const p3 = `${shaftEndX - perpX},${shaftEndY - perpY}`;

  return (
    `<line x1="${tail.x}" y1="${tail.y}" x2="${shaftEndX}" y2="${shaftEndY}" ` +
    `stroke="${toCssColor4(data.stroke.color)}" stroke-width="${sw}" ` +
    `stroke-linecap="round" stroke-linejoin="round" />` +
    `<polygon points="${p1} ${p2} ${p3}" fill="${toCssColor4(data.stroke.color)}" />`
  );
}

function ellipseToSvg(data: EllipseMarkerData, bounding: MarkerBounding): string {
  const sw = Math.max(0, data.stroke.width);
  const half = sw / 2;
  const w = Math.max(0, bounding.w - sw);
  const h = Math.max(0, bounding.h - sw);
  if (w <= 0 || h <= 0) return '';

  const cx = half + w / 2;
  const cy = half + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const fill = data.fill.opacity > 0 ? toCssColor4(data.fill.color) : 'none';
  const fillOpacity = data.fill.opacity > 0 ? data.fill.opacity : 0;

  return (
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" ` +
    `fill="${fill}" fill-opacity="${fillOpacity}" ` +
    `stroke="${toCssColor4(data.stroke.color)}" stroke-width="${sw}" />`
  );
}

// ─── Helpers ───

export function clampRadius(radius: number, w: number, h: number): number {
  const max = Math.min(w, h) / 2;
  return Math.max(0, Math.min(radius || 0, max));
}
