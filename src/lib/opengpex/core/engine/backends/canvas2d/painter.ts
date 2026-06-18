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

import { IMatrix3x3, Layer, ClipDescriptor, TileData } from '@opengpex/editor/core/types';
import { getAdjustmentsData } from '@opengpex/editor/core/helpers/filters';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';
import { shrinkInvertedMask } from '@opengpex/editor/core/helpers/sub-pixel';
import { TEXT_LAYER_PADDING } from '@opengpex/editor/core/helpers/config';

export interface PainterOptions {
  matrix?: IMatrix3x3 | { a: number; b: number; c: number; d: number; tx: number; ty: number };
  opacity?: number;
  clipSequence?: ClipDescriptor[];
  width?: number;   // Target width to draw
  height?: number;  // Target height to draw
  drawRect?: { x: number, y: number, w: number, h: number }; // Source rect mapping
  imageSmoothingQuality?: ImageSmoothingQuality;
  tileCount?: number; // [Optimization] How many tiles in the array are valid (for object pooling)
  dprScale?: number;
}

/**
 * Atomic painter: pure function, drawing pixels to target context without dependencies.
 * Follows the top-left origin (0, 0) coordinate system.
 */

export function applyClipSequence(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: Layer,
  clipSequence: ClipDescriptor[]
) {
  if (!clipSequence || clipSequence.length === 0) return;

  const padding = 2000;
  for (const clip of clipSequence) {
    const path = clip.__compiledPath2D || shapeToPath2D(shrinkInvertedMask(clip.shape, clip.inverted));
    if (clip.inverted) {
      // [Bugfix]: Correct local coordinate offset clipping boundary overrun issues when drawing inverted masks (hole punching).
      // Ensure the outer safety protection ring moves along with fragment position even if tile coordinate offset is very large.
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
      ctx.clip(path, 'nonzero');
    }
  }
}
export function drawLayerInstance(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: Layer,
  source: CanvasImageSource | ImageBitmap | TileData[] | null | undefined,
  options: PainterOptions = {}
) {
  const {
    matrix, opacity, clipSequence, drawRect,
    imageSmoothingQuality = 'high', tileCount, dprScale
  } = options;

  ctx.save();

  // 1. Inject geometric transformations
  if (matrix) {
    ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);
  }

  // 2. Inject style context
  ctx.imageSmoothingEnabled = false;
  ctx.imageSmoothingQuality = imageSmoothingQuality;
  ctx.filter = getAdjustmentsData(layer.adjustments);
  ctx.globalAlpha = opacity ?? layer.opacity;


  // 3. Inject mask clipping sequence
  applyClipSequence(ctx, layer, clipSequence || []);

  // 4. Execute pixel drawing (follows matrix positioning, starts drawing directly from (0,0))
  if (layer.type === 'color') {
    ctx.fillStyle = layer.metadata?.fillColor || '#000000';
    let clipped = false;
    if (layer.visibleShape && layer.visibleShape.type !== 'rect') {
      ctx.save();
      clipped = true;
      const path = shapeToPath2D(layer.visibleShape);
      ctx.clip(path);
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
    // Text layer rendering: using Canvas fillText API
    const td = layer.textData;
    ctx.fillStyle = td.color || '#FFFFFF';
    const fontStyle = td.italic ? 'italic' : 'normal';
    ctx.font = `${fontStyle} ${td.fontWeight || 400} ${td.fontSize || 24}px ${td.fontFamily || 'sans-serif'}`;
    ctx.textAlign = td.align || 'left';
    ctx.textBaseline = 'top';

    const fontSize = td.fontSize || 24;
    const lineH = fontSize * (td.lineHeight || 1.4);
    const boxMode = td.boxMode || 'auto';
    // Apply padding offset consistent with the editable contenteditable state to guarantee no visual jumps.
    // +1 compensates for border width: the 1px border in editable contenteditable pushes content in by 1px,
    // but the rasterized OffscreenCanvas has no border; we must manually add back this 1px to align.
    const padX = TEXT_LAYER_PADDING.x + 1;
    // Compensate for half-leading: vertical blank spaces split equally generated by line-height in contenteditable.
    // Canvas fillText(textBaseline:'top') starts from the glyph top, excluding leading, which must be manually added back.
    // +1 also compensates for the 1px of border-top.
    const halfLeading = (lineH - fontSize) / 2;
    const padY = TEXT_LAYER_PADDING.y + halfLeading + 1;
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
      // fixed mode: manually implement word-wrap
      const paragraphs = (td.content || '').split('\n');
      let currentY = padY;

      for (const paragraph of paragraphs) {
        const wrappedLines = wrapTextByChar(ctx, paragraph, maxWidth);
        for (const line of wrappedLines) {
          if (currentY + lineH > layer.bounding.h - padY) break;
          ctx.fillText(line, baseXOffset, currentY);
          drawDecorations(line, baseXOffset, currentY);
          currentY += lineH;
        }
        if (currentY + lineH > layer.bounding.h - padY) break;
      }
    } else {
      // auto mode
      const lines = (td.content || '').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineY = padY + i * lineH;
        ctx.fillText(lines[i], baseXOffset, lineY);
        drawDecorations(lines[i], baseXOffset, lineY);
      }
    }
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
        drawRect.x, drawRect.y, drawRect.w, drawRect.h
      );
    } else if (layer.visibleShape) {
      const v = layer.visibleShape.rect;

      let clipped = false;
      if (layer.visibleShape.type !== 'rect') {
        ctx.save();
        clipped = true;
        const path = shapeToPath2D(layer.visibleShape);
        ctx.clip(path);
      }

      ctx.drawImage(
        source,
        v.x * s, v.y * s, v.w * s, v.h * s,
        v.x, v.y, v.w, v.h
      );

      if (clipped) {
        ctx.restore();
      }
    } else {
      ctx.drawImage(source, 0, 0, layer.bounding.w, layer.bounding.h);
    }
  }

  ctx.restore();
}

/** Splits text by character to implement auto line-wrap (supports Chinese) */
function wrapTextByChar(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number
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

