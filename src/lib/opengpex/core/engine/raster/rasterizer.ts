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
 * rasterizer.ts — Layer-instance orchestration: draws a single layer instance
 * (currently text-bake only — see `RasterizeDispatcher.layer()`) to a 2D context.
 * Text drawing lives in `paintText.ts`.
 *
 * @module core/raster/rasterizer
 */

import type { AdjustmentState, LocalShape, MarkerData } from '@opengpex/editor/core/types';
import type { ColorValue } from '@opengpex/editor/core/engine/color/ColorValue';
import { drawTextContent } from './paintText';

// ─── LayerLike Interface ───

/**
 * Minimal layer fields consumed by the rasterizer — the duck-type contract.
 * Accepts both live Layer objects and offscreen LayerDescriptors.
 */
export interface LayerLike {
  type: string;
  bounding: { w: number; h: number };
  visibleShape?: LocalShape;
  vectorMasks?: unknown[];
  opacity: number;
  blendMode?: string;
  fill?: number;
  adjustments?: AdjustmentState;
  metadata?: { fillColor?: ColorValue; assocMaskId?: string; [key: string]: unknown };
  textData?: {
    content?: string;
    color?: ColorValue;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    italic?: boolean;
    lineHeight?: number;
    align?: CanvasTextAlign;
    boxMode?: 'auto' | 'fixed';
    boxWidth?: number;
    underline?: boolean;
    strikethrough?: boolean;
  };
  markerData?: MarkerData;
  assetId?: string;
}

// ─── DrawOptions ───

export interface DrawOptions {
  matrix?: { a: number; b: number; c: number; d: number; tx: number; ty: number };
  opacity?: number;
  width?: number;
  height?: number;
  imageSmoothingQuality?: ImageSmoothingQuality;
}

// ─── Core Drawing Function ───

/**
 * Core drawing function — draws a single layer instance to a 2D context.
 * Pure function: no DOM singletons, no Worker API — shared by main thread & offscreen worker.
 */
export function drawLayerInstance(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: LayerLike,
  options: DrawOptions = {},
): void {
  const { matrix, opacity, imageSmoothingQuality = 'high' } = options;

  ctx.save();

  if (matrix) {
    ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);
  }

  ctx.imageSmoothingEnabled = false;
  ctx.imageSmoothingQuality = imageSmoothingQuality;
  ctx.globalAlpha = (opacity ?? layer.opacity) * (layer.fill ?? 1);
  ctx.globalCompositeOperation = (layer.blendMode || 'source-over') as GlobalCompositeOperation;

  drawLayerContent(ctx, layer);

  ctx.restore();
}

// ─── Internal Content Drawer ───

/**
 * drawLayerContent: Draws the actual layer pixels.
 */
function drawLayerContent(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: LayerLike,
): void {
  if (layer.type === 'text' && layer.textData) {
    drawTextContent(ctx, layer, layer.textData);
  }
}
