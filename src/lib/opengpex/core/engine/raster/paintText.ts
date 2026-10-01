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
 * paintText.ts — text layer drawing primitives + wide-gamut coverage build.
 *
 * `drawTextContent` paints into a caller-owned 2D context (shared by the main
 * thread and offscreen worker via `rasterizer.ts`). `buildTextHighDepth` is the
 * Coverage×Tint wide-gamut counterpart: it paints a white
 * coverage mask and composites it against the text's tint into an rgba16float
 * `highDepthSource` buffer.
 *
 * @module core/raster/paintText
 */

import { toHex } from '@opengpex/editor/core/engine/color/ColorValue';
import { TEXT_LAYER_PADDING } from '@opengpex/editor/core/helpers/config';
import type { LayerLike } from './rasterizer';
import {
  compositeCoverageTints,
  resolveCoverageAlpha,
  type CompositedCoverage,
} from './coverageTint';

export function drawTextContent(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: LayerLike,
  td: NonNullable<LayerLike['textData']>,
  fillStyleOverride?: string,
): void {
  // 8-bit sRGB fallback for the default (no override) call: `toHex` clamps.
  // `buildTextHighDepth` passes a white override to paint a coverage mask for
  // the wide-gamut Coverage×Tint pipeline instead.
  ctx.fillStyle = fillStyleOverride ?? (td.color ? toHex(td.color) : '#FFFFFF');
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
  const baseXOffset =
    td.align === 'center'
      ? layer.bounding.w / 2
      : td.align === 'right'
        ? layer.bounding.w - padX
        : padX;

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
export function wrapTextByChar(
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

/**
 * Builds the high-depth coverage×tint buffer for a text layer. Returns
 * `undefined` when the layer has no structured colour (mirrors the
 * `drawTextContent` 8-bit fallback — nothing to tint against).
 */
export function buildTextHighDepth(
  layer: LayerLike,
  pxW: number,
  pxH: number,
  dpr: number,
): CompositedCoverage | undefined {
  const td = layer.textData;
  if (!td || !td.color) return undefined;

  const canvas = new OffscreenCanvas(pxW, pxH);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  drawTextContent(ctx, layer, td, '#FFFFFF');
  const { data } = ctx.getImageData(0, 0, pxW, pxH);
  const coverage = resolveCoverageAlpha(data);

  return compositeCoverageTints(pxW, pxH, [{ coverage, opacity: 1, tint: td.color }]);
}
