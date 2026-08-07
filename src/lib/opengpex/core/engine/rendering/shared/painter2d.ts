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
 * painter.ts — Engine V2 shared rendering layer.
 *
 * ISOMORPHISM BOUNDARY:
 * This module is imported by BOTH the main thread (`Canvas2dEngine`) AND the
 * engine worker (offscreen backends). Therefore it MUST NOT import any
 * main-thread singleton (SourceBitmapCache, WorkerBridge, FilterCache, etc.).
 *
 * It is a pure atomic drawer: it receives a `source` and paints it, nothing
 * more. Any pre-filter pixel work must be resolved by the caller and handed
 * in via `source` already substituted.
 *
 * Phase 1 adaptation from v1 `engine/backends/canvas2d/painter.ts`:
 * - Replaces `Layer` parameter with `LayerLike` minimal interface.
 * - Removes all v1 EngineProvider / service imports.
 * - Preserves pure function signatures for onscreen + offscreen sharing.
 */

import type { ClipDescriptor, TileData, AdjustmentState, LocalShape } from '@opengpex/editor/core/types';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';
import { shrinkInvertedMask } from '@opengpex/editor/core/helpers/sub-pixel';
import { TEXT_LAYER_PADDING } from '@opengpex/editor/core/helpers/config';

// ─── LayerLike Interface ───

/**
 * Minimal layer fields consumed by painter — the "duck type" contract.
 * Accepts both live `Layer` objects (onscreen) and `LayerDescriptor` (offscreen).
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
  metadata?: { fillColor?: string };
  textData?: {
    content?: string;
    color?: string;
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
  assetId?: string;
}

// ─── DrawOptions ───

export interface DrawOptions {
  matrix?: { a: number; b: number; c: number; d: number; tx: number; ty: number };
  opacity?: number;
  clipSequence?: ClipDescriptor[];
  width?: number;
  height?: number;
  drawRect?: { x: number; y: number; w: number; h: number };
  imageSmoothingQuality?: ImageSmoothingQuality;
  tileCount?: number;
  dprScale?: number;
}


// ─── Clip Utilities ───

/**
 * Checks whether a clip sequence contains any feathered masks.
 * When true, the rendering pipeline must use the offscreen compositing path.
 */
export function hasFeatheredClips(clipSequence: ClipDescriptor[]): boolean {
  if (!clipSequence || clipSequence.length === 0) return false;
  return clipSequence.some(clip => (clip.feather || 0) > 0);
}

/**
 * applyClipSequence: Apply hard-edge vector mask clipping (feather === 0 path only).
 * Zero-overhead fast path for masks without feathering.
 */
export function applyClipSequence(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: LayerLike,
  clipSequence: ClipDescriptor[],
): void {
  if (!clipSequence || clipSequence.length === 0) return;

  // [DEBUG] Skip inverted clips to test if seam disappears
  if ((globalThis as unknown as Record<string, unknown>).__SEAM_SKIP_CLIP) return;

  let scale = 1;
  try {
    const transform = ctx.getTransform();
    scale = Math.sqrt(transform.a * transform.a + transform.b * transform.b);
  } catch {
    // Fallback if getTransform is not supported
  }

  const padding = 2000;
  for (const clip of clipSequence) {
    // Skip feathered clips — handled separately via offscreen compositing
    if ((clip.feather || 0) > 0) continue;

    if (clip.inverted) {
      const path = clip.__compiledPath2D || shapeToPath2D(shrinkInvertedMask(clip.shape, clip.inverted, scale));
      const invertedPath = new Path2D();
      let vx = 0, vy = 0;
      if (layer.visibleShape) {
        vx = layer.visibleShape.rect.x;
        vy = layer.visibleShape.rect.y;
      }
      invertedPath.rect(vx - padding, vy - padding, layer.bounding.w + padding * 2, layer.bounding.h + padding * 2);
      invertedPath.addPath(path);
      ctx.clip(invertedPath, 'evenodd');
    } else {
      const path = clip.__compiledPath2D || shapeToPath2D(shrinkInvertedMask(clip.shape, clip.inverted, scale));
      ctx.clip(path, clip.shape.type === 'path' ? 'evenodd' : 'nonzero');
    }
  }
}

/**
 * applyFeatheredClipComposite: Applies feathered vector masks via offscreen canvas compositing.
 *
 * Algorithm:
 * 1. For each feathered clip descriptor, create a padded mask canvas.
 * 2. Fill the mask shape with white on the mask canvas.
 * 3. Apply Gaussian blur (ctx.filter) by re-drawing the mask onto itself.
 * 4. Composite the blurred mask using destination-in.
 */
export function applyFeatheredClipComposite(
  layerCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: LayerLike,
  clipSequence: ClipDescriptor[],
  canvasWidth: number,
  canvasHeight: number,
  dprScale: number = 1,
): void {
  if (!clipSequence || clipSequence.length === 0) return;

  const invertedPadding = 2000;

  for (const clip of clipSequence) {
    const feather = clip.feather || 0;
    if (feather <= 0) continue;

    const physicalRadius = feather * dprScale;
    const blurPad = Math.ceil(physicalRadius * 3);

    const maskW = canvasWidth + blurPad * 2;
    const maskH = canvasHeight + blurPad * 2;
    const maskCanvas = new OffscreenCanvas(maskW, maskH);
    const maskCtx = maskCanvas.getContext('2d')!;

    let vx = 0, vy = 0;
    if (layer.visibleShape) {
      vx = layer.visibleShape.rect.x;
      vy = layer.visibleShape.rect.y;
    }

    maskCtx.translate(blurPad - vx, blurPad - vy);

    const path = clip.__compiledPath2D || shapeToPath2D(shrinkInvertedMask(clip.shape, clip.inverted));

    if (clip.inverted) {
      const invertedPath = new Path2D();
      invertedPath.rect(vx - invertedPadding, vy - invertedPadding, layer.bounding.w + invertedPadding * 2, layer.bounding.h + invertedPadding * 2);
      invertedPath.addPath(path);
      maskCtx.fillStyle = '#ffffff';
      maskCtx.fill(invertedPath, 'evenodd');
    } else {
      maskCtx.fillStyle = '#ffffff';
      maskCtx.fill(path, clip.shape.type === 'path' ? 'evenodd' : 'nonzero');
    }

    // Apply Gaussian blur
    if (physicalRadius > 0) {
      const blurCanvas = new OffscreenCanvas(maskW, maskH);
      const blurCtx = blurCanvas.getContext('2d')!;
      blurCtx.filter = `blur(${physicalRadius}px)`;
      blurCtx.drawImage(maskCanvas, 0, 0);

      maskCtx.setTransform(1, 0, 0, 1, 0, 0);
      maskCtx.clearRect(0, 0, maskW, maskH);
      maskCtx.drawImage(blurCanvas, 0, 0);
    }

    // Composite blurred mask
    layerCtx.save();
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    layerCtx.globalCompositeOperation = 'destination-in';
    layerCtx.drawImage(maskCanvas, -blurPad, -blurPad);
    layerCtx.restore();
  }
}

// ─── Core Drawing Function ───

/**
 * Core drawing function — draws a single layer instance to a 2D context.
 * Pure function: no DOM singletons, no Worker API — shared by onscreen + offscreen.
 */
export function drawLayerInstance(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: LayerLike,
  source: CanvasImageSource | ImageBitmap | TileData[] | null | undefined,
  options: DrawOptions = {},
): void {
  const {
    matrix, opacity, clipSequence, drawRect,
    imageSmoothingQuality = 'high', tileCount, dprScale,
  } = options;

  const needsFeather = hasFeatheredClips(clipSequence || []);

  if (needsFeather) {
    // ═══════════════════════════════════════════════════════════
    // FEATHERED PATH: Offscreen canvas compositing
    // ═══════════════════════════════════════════════════════════
    const canvasW = Math.ceil(layer.bounding.w);
    const canvasH = Math.ceil(layer.bounding.h);
    if (canvasW <= 0 || canvasH <= 0) return;

    const offscreen = new OffscreenCanvas(canvasW, canvasH);
    const offCtx = offscreen.getContext('2d')!;

    offCtx.save();
    if (layer.visibleShape) {
      offCtx.translate(-layer.visibleShape.rect.x, -layer.visibleShape.rect.y);
    }
    offCtx.imageSmoothingEnabled = false;
    offCtx.imageSmoothingQuality = imageSmoothingQuality;

    applyClipSequence(offCtx, layer, clipSequence || []);
    drawLayerContent(offCtx, layer, source, drawRect, dprScale, tileCount);
    offCtx.restore();

    applyFeatheredClipComposite(offCtx, layer, clipSequence || [], canvasW, canvasH, 1);

    // Composite offscreen result to main canvas
    ctx.save();
    if (matrix) {
      ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);
    }
    ctx.globalAlpha = (opacity ?? layer.opacity) * (layer.fill ?? 1);
    ctx.globalCompositeOperation = (layer.blendMode || 'source-over') as GlobalCompositeOperation;

    let vx = 0, vy = 0;
    if (layer.visibleShape) {
      vx = layer.visibleShape.rect.x;
      vy = layer.visibleShape.rect.y;
    }
    ctx.drawImage(offscreen, vx, vy, layer.bounding.w, layer.bounding.h);
    ctx.restore();
  } else {
    // ═══════════════════════════════════════════════════════════
    // STANDARD PATH: Direct rendering with ctx.clip()
    // ═══════════════════════════════════════════════════════════
    ctx.save();

    if (matrix) {
      ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);
    }

    ctx.imageSmoothingEnabled = false;
    ctx.imageSmoothingQuality = imageSmoothingQuality;
    ctx.globalAlpha = (opacity ?? layer.opacity) * (layer.fill ?? 1);
    ctx.globalCompositeOperation = (layer.blendMode || 'source-over') as GlobalCompositeOperation;

    applyClipSequence(ctx, layer, clipSequence || []);
    drawLayerContent(ctx, layer, source, drawRect, dprScale, tileCount);

    ctx.restore();
  }
}

// ─── Internal Content Drawer ───

/**
 * drawLayerContent: Draws the actual layer pixels.
 * Extracted to avoid duplication between standard path and feathered offscreen path.
 */
function drawLayerContent(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: LayerLike,
  source: CanvasImageSource | ImageBitmap | TileData[] | null | undefined,
  drawRect: { x: number; y: number; w: number; h: number } | undefined,
  dprScale: number | undefined,
  tileCount: number | undefined,
): void {
  if (layer.type === 'color') {
    ctx.fillStyle = layer.metadata?.fillColor || '#000000';
    let clipped = false;
    if (layer.visibleShape && layer.visibleShape.type !== 'rect') {
      ctx.save();
      clipped = true;
      const path = shapeToPath2D(layer.visibleShape);
      ctx.clip(path, layer.visibleShape.type === 'path' ? 'evenodd' : 'nonzero');
    }
    if (layer.visibleShape) {
      const v = layer.visibleShape.rect;
      ctx.fillRect(v.x, v.y, v.w, v.h);
    } else {
      ctx.fillRect(0, 0, layer.bounding.w, layer.bounding.h);
    }
    if (clipped) {
      ctx.restore();
    }
  } else if (layer.type === 'text' && layer.textData) {
    drawTextContent(ctx, layer, layer.textData);
  } else if (Array.isArray(source)) {
    // TileData tile drawing branch
    const count = tileCount ?? source.length;
    for (let i = 0; i < count; i++) {
      const tile = source[i];
      ctx.save();
      ctx.translate(tile.x, tile.y);
      ctx.scale(tile.scale, tile.scale);
      ctx.drawImage(tile.bitmap, 0, 0, tile.bitmap.width + tile.overlap, tile.bitmap.height + tile.overlap);
      ctx.restore();
    }
  } else if (source) {
    const s = dprScale || 1;
    if (drawRect) {
      ctx.drawImage(
        source,
        drawRect.x * s, drawRect.y * s, drawRect.w * s, drawRect.h * s,
        drawRect.x, drawRect.y, drawRect.w, drawRect.h,
      );
    } else if (layer.visibleShape) {
      const v = layer.visibleShape.rect;

      let clipped = false;
      if (layer.visibleShape.type !== 'rect') {
        ctx.save();
        clipped = true;
        const path = shapeToPath2D(layer.visibleShape);
        ctx.clip(path, layer.visibleShape.type === 'path' ? 'evenodd' : 'nonzero');
      }

      ctx.drawImage(
        source,
        v.x * s, v.y * s, v.w * s, v.h * s,
        v.x, v.y, v.w, v.h,
      );

      if (clipped) {
        ctx.restore();
      }
    } else {
      ctx.drawImage(source, 0, 0, layer.bounding.w, layer.bounding.h);
    }
  }
}

// ─── Text Rendering ───

function drawTextContent(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: LayerLike,
  td: NonNullable<LayerLike['textData']>,
): void {
  ctx.fillStyle = td.color || '#FFFFFF';
  const fontStyle = td.italic ? 'italic' : 'normal';
  ctx.font = `${fontStyle} ${td.fontWeight || 400} ${td.fontSize || 24}px ${td.fontFamily || 'sans-serif'}`;
  ctx.textAlign = td.align || 'left';
  ctx.textBaseline = 'top';

  const fontSize = td.fontSize || 24;
  const lineH = fontSize * (td.lineHeight || 1.4);
  const boxMode = td.boxMode || 'auto';

  const padX = TEXT_LAYER_PADDING.x;
  const halfLeading = (lineH - fontSize) / 2;
  const padY = TEXT_LAYER_PADDING.y + halfLeading;
  const maxWidth = boxMode === 'fixed' ? ((td.boxWidth || layer.bounding.w) - padX * 2) : undefined;
  const baseXOffset = td.align === 'center' ? layer.bounding.w / 2 : td.align === 'right' ? layer.bounding.w - padX : padX;

  const drawDecorations = (lineText: string, x: number, y: number) => {
    if (!td.underline && !td.strikethrough) return;
    const metrics = ctx.measureText(lineText);
    const lineWidth = metrics.width;
    const startX = td.align === 'center' ? x - lineWidth / 2 : td.align === 'right' ? x - lineWidth : x;
    const thickness = Math.max(1, Math.round(fontSize / 16));

    if (td.underline) {
      ctx.fillRect(startX, y + fontSize + 1, lineWidth, thickness);
    }
    if (td.strikethrough) {
      ctx.fillRect(startX, y + fontSize / 2 + 1, lineWidth, thickness);
    }
  };

  if (boxMode === 'fixed' && maxWidth) {
    const paragraphs = (td.content || '').split('\n');
    let currentY = padY;

    for (const paragraph of paragraphs) {
      const wrappedLines = wrapTextByChar(ctx, paragraph, maxWidth);
      for (const line of wrappedLines) {
        if (currentY >= layer.bounding.h) break;
        ctx.fillText(line, baseXOffset, currentY);
        drawDecorations(line, baseXOffset, currentY);
        currentY += lineH;
      }
      if (currentY >= layer.bounding.h) break;
    }
  } else {
    const lines = (td.content || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lineY = padY + i * lineH;
      ctx.fillText(lines[i], baseXOffset, lineY);
      drawDecorations(lines[i], baseXOffset, lineY);
    }
  }
}

/** Splits text by character for auto line-wrap (supports CJK). */
function wrapTextByChar(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  if (!text) return [''];
  const lines: string[] = [];
  let currentLine = '';

  for (const char of text) {
    const testLine = currentLine + char;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = char;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [''];
}
