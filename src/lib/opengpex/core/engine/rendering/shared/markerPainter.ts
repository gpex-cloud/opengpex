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
 * markerPainter.ts — core marker (annotation shape) drawing primitives.
 *
 * ISOMORPHISM BOUNDARY (same as painter2d.ts):
 * This module is shared by BOTH the main thread (onscreen `painter2d`) AND the
 * pre-rasterize path (`CompositeDispatcher.preRasterizeMarker`, which draws onto
 * an OffscreenCanvas). It MUST therefore stay a set of pure Canvas2D functions
 * with no DOM singletons / Worker APIs.
 *
 * Design mirror: this file is the marker counterpart of `drawTextContent`
 * inside `painter2d.ts` — a leaf drawer that turns a vector descriptor
 * (`markerData`) into pixels (`paintMarker`) or an SVG string (`markerToSvg`).
 * The overlay preview (plugin) reuses `markerToSvg`; the render pipeline
 * (screen + composite/export/merge) reuses `paintMarker`.
 *
 * Coordinate space: the caller has already translated `ctx` to the layer-local
 * origin (bounding box top-left), identical to the `text` branch. Rect geometry
 * is implicitly `bounding.w × bounding.h`; arrow geometry uses `tail`/`head`
 * expressed in the same layer-local space.
 */

import type { MarkerData, RectMarkerData, ArrowMarkerData, EllipseMarkerData } from '@opengpex/editor/core/types';

/** Minimal bounding contract — accepts both live Layer.bounding and descriptors. */
export interface MarkerBounding {
  w: number;
  h: number;
}

// ─── Canvas2D Rendering ───

/**
 * paintMarker: draw a marker into a 2D context (layer-local origin).
 *
 * Pure function — dispatches on `markerData.kind`. Uses only Canvas2D APIs
 * available on BOTH `CanvasRenderingContext2D` and
 * `OffscreenCanvasRenderingContext2D`, so it runs on the main thread and on
 * OffscreenCanvas alike.
 */
export function paintMarker(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  markerData: MarkerData,
  bounding: MarkerBounding,
): void {
  switch (markerData.kind) {
    case 'rect':
      paintRect(ctx, markerData, bounding);
      break;
    case 'arrow':
      paintArrow(ctx, markerData);
      break;
    case 'ellipse':
      paintEllipse(ctx, markerData, bounding);
      break;
    default: {
      // Exhaustiveness guard — new kinds must add a case above.
      const _never: never = markerData;
      void _never;
    }
  }
}

function paintRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: RectMarkerData,
  bounding: MarkerBounding,
): void {
  const sw = Math.max(0, data.stroke.width);
  const half = sw / 2;

  // Inset by half the stroke width so the border sits inside the bounding box.
  const x = half;
  const y = half;
  const w = Math.max(0, bounding.w - sw);
  const h = Math.max(0, bounding.h - sw);
  if (w <= 0 || h <= 0) return;

  const radius = clampRadius(data.cornerRadius, w, h);

  ctx.save();
  buildRoundRectPath(ctx, x, y, w, h, radius);

  if (data.fill.opacity > 0) {
    ctx.globalAlpha = data.fill.opacity;
    ctx.fillStyle = data.fill.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  if (sw > 0) {
    ctx.lineWidth = sw;
    ctx.strokeStyle = data.stroke.color;
    ctx.lineJoin = 'miter';
    ctx.stroke();
  }
  ctx.restore();
}

function paintArrow(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ArrowMarkerData,
): void {
  const sw = Math.max(0, data.stroke.width);
  const { tail, head } = data;

  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const len = Math.hypot(dx, dy);
  if (len <= 0) return;

  const angle = Math.atan2(dy, dx);
  const headScale = data.headScale || 3;
  const headLen = sw * headScale;
  // Half-width of the arrowhead base (gives a barbed head).
  const headHalfW = headLen * 0.5;

  // Shorten the shaft so it stops at the base of the arrowhead (avoids the
  // stroke poking through the tip).
  const shaftEndX = head.x - Math.cos(angle) * headLen;
  const shaftEndY = head.y - Math.sin(angle) * headLen;

  ctx.save();
  ctx.strokeStyle = data.stroke.color;
  ctx.fillStyle = data.stroke.color;
  ctx.lineWidth = sw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Shaft
  ctx.beginPath();
  ctx.moveTo(tail.x, tail.y);
  ctx.lineTo(shaftEndX, shaftEndY);
  ctx.stroke();

  // Arrowhead (filled triangle)
  const perpX = -Math.sin(angle) * headHalfW;
  const perpY = Math.cos(angle) * headHalfW;

  ctx.beginPath();
  ctx.moveTo(head.x, head.y);
  ctx.lineTo(shaftEndX + perpX, shaftEndY + perpY);
  ctx.lineTo(shaftEndX - perpX, shaftEndY - perpY);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function paintEllipse(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: EllipseMarkerData,
  bounding: MarkerBounding,
): void {
  const sw = Math.max(0, data.stroke.width);
  const half = sw / 2;

  // Inset by half the stroke width so the border sits inside the bounding box.
  const w = Math.max(0, bounding.w - sw);
  const h = Math.max(0, bounding.h - sw);
  if (w <= 0 || h <= 0) return;

  const cx = half + w / 2;
  const cy = half + h / 2;
  const rx = w / 2;
  const ry = h / 2;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);

  if (data.fill.opacity > 0) {
    ctx.globalAlpha = data.fill.opacity;
    ctx.fillStyle = data.fill.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  if (sw > 0) {
    ctx.lineWidth = sw;
    ctx.strokeStyle = data.stroke.color;
    ctx.stroke();
  }
  ctx.restore();
}


// ─── SVG Rendering ───

/**
 * markerToSvg: build an SVG fragment string for a marker (layer-local origin).
 * Structurally symmetric with `paintMarker`; consumed by the overlay preview
 * (plugin) so the on-canvas preview matches the rasterized output.
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
  const fill = data.fill.opacity > 0 ? data.fill.color : 'none';
  const fillOpacity = data.fill.opacity > 0 ? data.fill.opacity : 0;

  return (
    `<rect x="${half}" y="${half}" width="${w}" height="${h}" ` +
    `rx="${radius}" ry="${radius}" ` +
    `fill="${fill}" fill-opacity="${fillOpacity}" ` +
    `stroke="${data.stroke.color}" stroke-width="${sw}" ` +
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
    `stroke="${data.stroke.color}" stroke-width="${sw}" ` +
    `stroke-linecap="round" stroke-linejoin="round" />` +
    `<polygon points="${p1} ${p2} ${p3}" fill="${data.stroke.color}" />`
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
  const fill = data.fill.opacity > 0 ? data.fill.color : 'none';
  const fillOpacity = data.fill.opacity > 0 ? data.fill.opacity : 0;

  return (
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" ` +
    `fill="${fill}" fill-opacity="${fillOpacity}" ` +
    `stroke="${data.stroke.color}" stroke-width="${sw}" />`
  );
}

// ─── Helpers ───

/** Clamp corner radius so it never exceeds half the smaller side. */
function clampRadius(radius: number, w: number, h: number): number {
  const max = Math.min(w, h) / 2;
  return Math.max(0, Math.min(radius || 0, max));
}

/**
 * buildRoundRectPath: begin a new path describing a (rounded) rectangle.
 *
 * Implemented manually with `arcTo` instead of `ctx.roundRect`, because
 * `roundRect` is not yet available on `OffscreenCanvasRenderingContext2D` in
 * every runtime we target — this keeps the isomorphism guarantee intact.
 */
function buildRoundRectPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
