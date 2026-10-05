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

import { Matrix3x3 } from '../matrix';
import { CameraState, Dimensions, ViewportPoint, Point2D, WorldRect, LocalRect, asWorldRect, asLocalRect } from '@opengpex/editor/core/types';
import { presets } from '@opengpex/editor/core/helpers/preferences';
const VIEWPORT_ZOOM_MIN = presets.get('VIEWPORT_ZOOM_MIN');
const VIEWPORT_ZOOM_MAX = presets.get('VIEWPORT_ZOOM_MAX');

export interface CameraCenterOptions {
  padding?: number;
  fixedScale?: number;
  maxScale?: number;
  offsetTop?: number;
  offsetBottom?: number;
  offsetLeft?: number;
  offsetRight?: number;
}

/**
 * Calculate optimal camera parameters (Fit into View)
 * [Internal] Logic: ensure that the content center and the viewport usable area center are physically aligned through matrix derivation.
 */
function calculateFit(
  viewport: Dimensions,
  content: Dimensions,
  options: CameraCenterOptions = {}
): CameraState {
  const {
    padding = 40,
    fixedScale,
    maxScale,
    offsetTop = 0,
    offsetBottom = 0,
    offsetLeft = 0,
    offsetRight = 0
  } = options;

  if (content.w === 0 || content.h === 0 || viewport.w === 0 || viewport.h === 0) {
    return { x: 0, y: 0, k: 1 };
  }

  const availableW = viewport.w - (padding * 2) - offsetLeft - offsetRight;
  const availableH = viewport.h - (padding * 2) - offsetTop - offsetBottom;

  let k: number;
  if (fixedScale !== undefined) {
    k = fixedScale;
  } else {
    const fitK = Math.min(availableW / content.w, availableH / content.h);
    // [REFACTOR-2026-06-22] Removed `* VIEWPORT_FIT_FACTOR (0.90)`; breathing
    // room is now expressed solely via the explicit `padding` option, avoiding
    // double-compensation between padding and an implicit shrink factor.
    k = maxScale !== undefined ? Math.min(maxScale, fitK) : fitK;
  }

  // Derive via matrix: we need the content center to coincide with the usable area center
  const centerX = (viewport.w + offsetLeft - offsetRight) / 2;
  const centerY = (viewport.h + offsetTop - offsetBottom) / 2;

  const p = Matrix3x3.translate(centerX, centerY).apply({
    x: -(content.w * k) / 2,
    y: -(content.h * k) / 2
  });

  return { x: p.x, y: p.y, k };
}

/**
 * Calculate camera center (centers image in viewport)
 */
export function getFitCamera(
  viewport: Dimensions,
  image: Dimensions,
  options: CameraCenterOptions = {}
): CameraState {
  return calculateFit(viewport, image, options);
}

/**
 * Project Zoom: Fixed-point scaling algorithm based on matrix derivation.
 * Logic: uses Matrix3x3.zoomAt to generate transform matrix and re-extract coordinates.
 */
export function projectZoom(
  current: CameraState,
  zoomDelta: number,
  anchor: ViewportPoint,
  limits: { min: number; max: number } = { min: VIEWPORT_ZOOM_MIN, max: VIEWPORT_ZOOM_MAX }
): CameraState {
  const { x: curX, y: curY, k: curK } = current;
  const ratio = 1 + zoomDelta;
  const nextK = Math.max(limits.min, Math.min(curK * ratio, limits.max));

  // Core logic: M_camera = Translate(x, y) * Scale(k)
  // When performing fixed-point scaling: M_next = ZoomAt(anchor, actualRatio) * M_camera
  const actualRatio = nextK / curK;
  const M_cam = Matrix3x3.translate(curX, curY).multiply(Matrix3x3.scale(curK));
  const M_next = Matrix3x3.zoomAt(anchor, actualRatio).multiply(M_cam);

  return {
    x: M_next.tx,
    y: M_next.ty,
    k: nextK
  };
}

/**
 * Project Pan: Simple vector translation.
 */
export function projectPan(
  current: CameraState,
  delta: Point2D
): CameraState {
  return {
    ...current,
    x: current.x + delta.x,
    y: current.y + delta.y
  };
}

/**
 * Convert Matrix3x3 to semantic CameraState
 */
export function toCameraState(m: Matrix3x3): CameraState {
  return {
    x: m.tx,
    y: m.ty,
    k: m.a
  };
}

/**
 * Get viewport projection matrix (View Projection Matrix)
 * Logic: Screen = CameraTranslate * CameraScale * CanvasCenterTranslate * World
 */
export function getCameraMatrix(cam: CameraState, canvasDim: Dimensions): Matrix3x3 {
  return Matrix3x3.translate(cam.x, cam.y)
    .multiply(Matrix3x3.scale(cam.k))
    .multiply(Matrix3x3.translate(canvasDim.w / 2, canvasDim.h / 2));
}

/**
 * Calculate the viewport bounding rectangle under the world coordinate system (Viewport to World AABB)
 */
export function getViewportWorldRect(
  viewportDim: Dimensions,
  camera: CameraState,
  canvas: Dimensions,
  padding: number = 0
): WorldRect {
  const viewM = getCameraMatrix(camera, canvas);
  const invViewM = viewM.inverse();

  if (!invViewM) return asWorldRect({ x: 0, y: 0, w: 0, h: 0 });

  const corners = [
    invViewM.apply({ x: -padding, y: -padding }),
    invViewM.apply({ x: viewportDim.w + padding, y: -padding }),
    invViewM.apply({ x: viewportDim.w + padding, y: viewportDim.h + padding }),
    invViewM.apply({ x: -padding, y: viewportDim.h + padding })
  ];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of corners) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  return asWorldRect({
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Viewport culling: visible window infrastructure.
//
// Single source for the "what part of the document is on screen" question:
// maps the viewport through the camera into frame-local space, pads it with a
// safety margin, and snaps it outward to a block lattice so that small pans
// produce the IDENTICAL rect and key (stable cache identity for consumers
// like the marching-ants viewport culling).
//
// Scope boundary: this block owns viewport→rect mapping + quantization ONLY.
// What "outside the window" means (uncovered grid cells / skipped anchors /
// texel ROI) stays in each consumer's domain.
// ───────────────────────────────────────────────────────────────────────────────

/**
 * GridOffset: WHERE the target layer's document-pixel-grid lines fall — the
 * fractional part (0 or 0.5) of the TARGET LAYER's origin (the active layer
 * the cut/mask will be applied to) expressed in frame-local space. Pixel
 * (k, row) of that layer spans
 * `[gx + k, gx + k + 1] × [gy + row, gy + row + 1]`,
 * so any pixel-aligned derivation (ants staircase) MUST be computed on this
 * grid or it misaligns by 1px when the parities of the canvas and layer
 * dimensions differ (layer origin lands at .5). The integer part is
 * deliberately dropped: cells are unit-sized, so only the phase matters.
 */
export interface GridOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * Snap a frame-local coordinate's fraction onto the grid-offset domain
 * {0, 0.5}. Tolerates float drift in layer matrices: < .25 → 0, within
 * ±.25 of .5 → .5, otherwise back to 0.
 */
export function quantizeGridOffset(v: number): 0 | 0.5 {
  const f = v - Math.floor(v);
  return f < 0.25 ? 0 : f < 0.75 ? 0.5 : 0;
}

/**
 * Visible-window bounds in GRID CELL INDEX space (inclusive): pixel-aligned
 * derivations consume ONLY cells (k, row) within [k0..k1] × [r0..r1]. Cells
 * outside are treated as uncovered — e.g. the ants staircase terminates
 * against the window edges (contours close along them), keeping the emitted
 * path viewport-sized.
 */
export interface GridWindow {
  readonly k0: number;
  readonly r0: number;
  readonly k1: number;
  readonly r1: number;
}

export interface VisibleRectOptions {
  /**
   * Safety margin in DOCUMENT units around the viewport rect before
   * quantization: 'halfDiagonal' (default) pads by half the viewport
   * diagonal — guaranteed to cover any pan until the next re-derive —
   * or an explicit number.
   */
  margin?: 'halfDiagonal' | number;
  /**
   * Quantization block size in CSS px (default 128). The document-space
   * block size is `blockSizeCssPx / cam.k`; the rect is snapped OUTWARD to
   * block boundaries, so pans within a block keep the same rect and key.
   */
  blockSizeCssPx?: number;
}

export interface VisibleRect {
  /** Viewport (+ margin, block-snapped) rect in frame-local space. */
  rect: LocalRect;
  /** Stable identity of the quantized rect — cache key across ticks. */
  key: string;
}

/**
 * getVisibleRect: viewport → (margin-padded, block-quantized) frame-local rect.
 *
 * Frame-local mapping via `inv(T(cam.x, cam.y)·S(k))` — the same transform as
 * `space.ts::screenToLocal` (local = T(canvas/2)·world, so the camera inverse
 * alone lands in frame-local space; no canvas translate involved).
 *
 * Returns null for a degenerate camera (scale ≤ 0) or empty viewport —
 * consumers fall back to uncapped behavior.
 */
export function getVisibleRect(
  viewportDim: Dimensions,
  cam: CameraState,
  options: VisibleRectOptions = {},
): VisibleRect | null {
  const scale = cam.k;
  if (!(viewportDim.w > 0 && viewportDim.h > 0) || !(scale > 0)) return null;

  const invM = Matrix3x3.translate(cam.x, cam.y)
    .multiply(Matrix3x3.scale(scale))
    .inverse();
  const p0 = invM.apply({ x: 0, y: 0 });
  const p1 = invM.apply({ x: viewportDim.w, y: viewportDim.h });
  const x0 = Math.min(p0.x, p1.x);
  const x1 = Math.max(p0.x, p1.x);
  const y0 = Math.min(p0.y, p1.y);
  const y1 = Math.max(p0.y, p1.y);

  const margin = options.margin === undefined || options.margin === 'halfDiagonal'
    ? Math.hypot(x1 - x0, y1 - y0) / 2
    : options.margin;
  const block = (options.blockSizeCssPx ?? 128) / scale;

  // Snap outward to block boundaries: the rect only ever GROWS across pans,
  // and slides by whole blocks — same rect ⇒ same key ⇒ consumers' caches hit.
  const wx0 = Math.floor((x0 - margin) / block) * block;
  const wy0 = Math.floor((y0 - margin) / block) * block;
  const wx1 = Math.ceil((x1 + margin) / block) * block;
  const wy1 = Math.ceil((y1 + margin) / block) * block;

  const rect = asLocalRect({ x: wx0, y: wy0, w: wx1 - wx0, h: wy1 - wy0 });
  return { rect, key: `${wx0},${wy0},${wx1},${wy1}` };
}

/**
 * visibleGridWindow: one-stop visible window for pixel-aligned derivations —
 * `getVisibleRect` + the LocalRect → grid-cell conversion in a single call.
 *
 * The cell mapping is THE contract with pixel-aligned consumers (the ants
 * staircase scanline derives exactly these cells): cell (k, r) covers
 * frame-local `[gx+k, gx+k+1] × [gy+r, gy+r+1]` where (gx, gy) = gridOffset.
 *
 * Returns `{ window: undefined, key: 'full' }` for a degenerate camera/viewport
 * (consumer falls back to uncapped derivation) and `{ window: undefined, key }`
 * when the visible rect maps to no grid cells (still keyed by the rect).
 */
export function visibleGridWindow(
  viewportDim: Dimensions,
  cam: CameraState,
  gridOffset: GridOffset,
  options: VisibleRectOptions = {},
): { window?: GridWindow; key: string } {
  const visible = getVisibleRect(viewportDim, cam, options);
  if (!visible) return { window: undefined, key: 'full' };

  const k0 = Math.floor(visible.rect.x - gridOffset.x);
  const r0 = Math.floor(visible.rect.y - gridOffset.y);
  const k1 = Math.ceil(visible.rect.x + visible.rect.w - gridOffset.x) - 1;
  const r1 = Math.ceil(visible.rect.y + visible.rect.h - gridOffset.y) - 1;
  const window = k1 < k0 || r1 < r0 ? undefined : { k0, r0, k1, r1 };
  return { window, key: visible.key };
}
