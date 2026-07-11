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

import { IMatrix3x3, Layer, ClipDescriptor, TileData, AdjustmentState } from '@opengpex/editor/core/types';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';

import { shrinkInvertedMask } from '@opengpex/editor/core/helpers/sub-pixel';
import { TEXT_LAYER_PADDING } from '@opengpex/editor/core/helpers/config';

// ═══════════════════════════════════════════════════════════════════════════
// ISOMORPHISM BOUNDARY (see 20260709_filter_step3_retrospective §2)
// ---------------------------------------------------------------------------
// This module is imported by BOTH the main thread (`Canvas2dEngine`) AND the
// engine worker (`worker/core/EngineProvider`). Therefore it MUST NOT import
// any main-thread singleton — in particular:
//   - core/engine/cache/AsyncFilterCache  (holds a WorkerBridge, spawns Worker)
//   - core/engine/worker/WorkerBridge     (spawns Worker on module init)
//   - Anything transitively pulling `WorkerBridge` into the graph
//
// The advanced-filter dispatch (curves/levels/channelMix) belongs in the
// main-thread `Canvas2dEngine.executeCommand()` layer, NOT here. `painter.ts`
// is a pure atomic drawer: it receives a `source` and paints it, nothing more.
// Any pre-filter pixel work must be resolved by the caller and handed in via
// `source` already substituted.
// ═══════════════════════════════════════════════════════════════════════════


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

/**
 * Convert `AdjustmentState` into a CSS-filter string consumable by
 * `CanvasRenderingContext2D.filter` / `OffscreenCanvasRenderingContext2D.filter`.
 *
 * Kept private to the Canvas2D backend — advanced grading (curves / levels /
 * channel mixer) does NOT flow through this helper, it goes through the
 * `IFilter` runtime instead (see spec §5.1 dispatch logic). The Basic panel
 * of `AdjustmentDrawer` (formerly `AdjustmentDrawer` before Step 7.5)
 * continues to use this fast path.

 */
function getAdjustmentsData(adj?: AdjustmentState): string {
  if (!adj) return 'none';
  const parts: string[] = [];
  if (adj.brightness !== 100) parts.push(`brightness(${adj.brightness}%)`);
  if (adj.contrast !== 100) parts.push(`contrast(${adj.contrast}%)`);
  if (adj.saturation !== 100) parts.push(`saturate(${adj.saturation}%)`);
  if (adj.hueRotate !== 0) parts.push(`hue-rotate(${adj.hueRotate}deg)`);
  if (adj.blur !== 0) parts.push(`blur(${adj.blur}px)`);
  return parts.length > 0 ? parts.join(' ') : 'none';
}

/**
 * Checks whether a clip sequence contains any feathered masks.

 * When true, the rendering pipeline must use the offscreen compositing path
 * instead of the simple ctx.clip() path.
 */
export function hasFeatheredClips(clipSequence: ClipDescriptor[]): boolean {
  if (!clipSequence || clipSequence.length === 0) return false;
  return clipSequence.some(clip => (clip.feather || 0) > 0);
}

/**
 * applyClipSequence: Apply hard-edge vector mask clipping (feather === 0 path only).
 * This function is the zero-overhead fast path for masks without feathering.
 * When feather > 0 masks exist, they are handled by applyFeatheredClipComposite instead.
 */
export function applyClipSequence(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: Layer,
  clipSequence: ClipDescriptor[]
) {
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
    // Skip feathered clips — they are handled separately via offscreen compositing
    if ((clip.feather || 0) > 0) continue;

    if (clip.inverted) {
      // [Bugfix]: Correct local coordinate offset clipping boundary overrun issues when drawing inverted masks (hole punching).
      // Ensure the outer safety protection ring moves along with fragment position even if tile coordinate offset is very large.
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
      // Path-type shapes (polygon-derived, e.g. inverted selections with multi-ring
      // geometry) require 'evenodd' to correctly produce holes. Rect/circle shapes
      // are single-path and 'nonzero' is fine (avoids sub-pixel seam differences).
      ctx.clip(path, clip.shape.type === 'path' ? 'evenodd' : 'nonzero');
    }
  }
}

/**
 * applyFeatheredClipComposite: Applies feathered vector masks via offscreen canvas compositing.
 *
 * Algorithm:
 * 1. For each feathered clip descriptor, create a padded mask canvas.
 * 2. Fill the mask shape (offset by padding) with white on the mask canvas.
 * 3. Apply Gaussian blur (ctx.filter = 'blur(Npx)') by re-drawing the mask onto itself.
 * 4. Composite the blurred mask onto the layerCanvas using destination-in.
 *
 * The mask canvas is enlarged by `ceil(feather * 3)` padding on each side to prevent
 * Gaussian blur truncation at canvas edges. The final composite draws the padded mask
 * at negative offset to align it back with the layer content.
 *
 * This function is called AFTER the layer content has been drawn onto `layerCanvas`.
 * The `dprScale` parameter converts logical feather px to physical blur radius.
 */
export function applyFeatheredClipComposite(
  layerCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: Layer,
  clipSequence: ClipDescriptor[],
  canvasWidth: number,
  canvasHeight: number,
  dprScale: number = 1
) {
  if (!clipSequence || clipSequence.length === 0) return;

  const invertedPadding = 2000;

  for (const clip of clipSequence) {
    const feather = clip.feather || 0;
    if (feather <= 0) continue; // Non-feathered clips are already handled by applyClipSequence

    // Compute physical blur radius (feather is in layer-local logical pixels)
    const physicalRadius = feather * dprScale;

    // Padding to prevent blur truncation at canvas edges.
    // Gaussian blur at radius R extends ~3R pixels beyond the source edge.
    const blurPad = Math.ceil(physicalRadius * 3);

    // Create a padded mask canvas
    const maskW = canvasWidth + blurPad * 2;
    const maskH = canvasHeight + blurPad * 2;
    const maskCanvas = new OffscreenCanvas(maskW, maskH);
    const maskCtx = maskCanvas.getContext('2d')!;

    let vx = 0, vy = 0;
    if (layer.visibleShape) {
      vx = layer.visibleShape.rect.x;
      vy = layer.visibleShape.rect.y;
    }

    // [Coordinate Translation Rationale]
    // The feathered vector mask shape is defined in the original/parent layer coordinates (with vx, vy offset).
    // Since the layer content has been translated to land at (0,0) of the offscreen canvas, we must also
    // translate the mask shape by (-vx, -vy) in addition to the blurPad (which offsets the Gaussian blur padding).
    // This ensures both the blurred mask and the content align perfectly at (0,0) of the offscreen canvas.
    maskCtx.translate(blurPad - vx, blurPad - vy);

    // Draw the mask shape (white fill on transparent background)
    const path = clip.__compiledPath2D || shapeToPath2D(shrinkInvertedMask(clip.shape, clip.inverted));

    if (clip.inverted) {
      // For inverted feathered masks: fill the entire area white, then cut out the shape
      const invertedPath = new Path2D();
      invertedPath.rect(vx - invertedPadding, vy - invertedPadding, layer.bounding.w + invertedPadding * 2, layer.bounding.h + invertedPadding * 2);
      invertedPath.addPath(path);
      maskCtx.fillStyle = '#ffffff';
      maskCtx.fill(invertedPath, 'evenodd');
    } else {
      // For non-inverted feathered masks: fill only the shape area.
      // Path-type shapes (polygon-derived, e.g. inverted selections) require 'evenodd'
      // to correctly produce holes in multi-ring paths.
      maskCtx.fillStyle = '#ffffff';
      maskCtx.fill(path, clip.shape.type === 'path' ? 'evenodd' : 'nonzero');
    }

    // Apply Gaussian blur to the mask by re-drawing with filter
    if (physicalRadius > 0) {
      const blurCanvas = new OffscreenCanvas(maskW, maskH);
      const blurCtx = blurCanvas.getContext('2d')!;
      blurCtx.filter = `blur(${physicalRadius}px)`;
      blurCtx.drawImage(maskCanvas, 0, 0);

      // Clear original mask and copy blurred result back
      maskCtx.setTransform(1, 0, 0, 1, 0, 0); // Reset before clearing
      maskCtx.clearRect(0, 0, maskW, maskH);
      maskCtx.drawImage(blurCanvas, 0, 0);
    }

    // Composite: draw the padded+blurred mask at (-blurPad, -blurPad) to align with layer content
    layerCtx.save();
    layerCtx.setTransform(1, 0, 0, 1, 0, 0); // Reset to identity for pixel-space compositing
    layerCtx.globalCompositeOperation = 'destination-in';
    layerCtx.drawImage(maskCanvas, -blurPad, -blurPad);
    layerCtx.restore();
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

  // Detect if feathered compositing path is needed
  const needsFeather = hasFeatheredClips(clipSequence || []);

  // NOTE: Advanced-filter dispatch (curves/levels/channelMix → AsyncFilterCache)
  // used to live here in Step 3 of the filter pipeline rollout, but violated
  // the isomorphism boundary above and coincided with a 10s tab crash. It has
  // been reverted per docs/opengpex/plans/20260709_filter_step3_retrospective.
  // The dispatch is being moved up to `Canvas2dEngine.executeCommand` in
  // Step 4; until then, layers with curves/levels/channelMix render the base
  // adjustments only (spec §5.1 acknowledges this as the fall-back path).

  if (needsFeather) {
    // ═══════════════════════════════════════════════════════════════════════════
    // FEATHERED PATH: Offscreen canvas compositing
    // The offscreen operates in LAYER-LOCAL coordinates (identity transform).
    // Only the final composite step applies the full viewport matrix.
    // ═══════════════════════════════════════════════════════════════════════════
    const canvasW = Math.ceil(layer.bounding.w);
    const canvasH = Math.ceil(layer.bounding.h);
    if (canvasW <= 0 || canvasH <= 0) return;

    const offscreen = new OffscreenCanvas(canvasW, canvasH);
    const offCtx = offscreen.getContext('2d')!;

    // Draw content onto offscreen in layer-local space (NO matrix — identity)
    offCtx.save();
    // [Coordinate Translation Rationale]
    // Cropped layers (fragments) draw their pixel content at original offset coordinates (vx, vy).
    // Because the offscreen canvas is compact (only matching the cropped width/height),
    // we translate offCtx by (-vx, -vy) so that the drawn content lands exactly at (0, 0)
    // inside the offscreen canvas boundaries, preventing it from being drawn out-of-bounds.
    if (layer.visibleShape) {
      offCtx.translate(-layer.visibleShape.rect.x, -layer.visibleShape.rect.y);
    }
    offCtx.imageSmoothingEnabled = false;
    offCtx.imageSmoothingQuality = imageSmoothingQuality;
    offCtx.filter = getAdjustmentsData(layer.adjustments);

    // Apply only hard clips (feather === 0 clips) — these are already in layer-local coords
    applyClipSequence(offCtx, layer, clipSequence || []);

    drawLayerContent(offCtx, layer, source, drawRect, dprScale, tileCount);
    offCtx.restore();

    // Apply feathered masks via offscreen compositing (layer-local space, dprScale=1)
    applyFeatheredClipComposite(offCtx, layer, clipSequence || [], canvasW, canvasH, 1);

    // Composite offscreen result to main canvas with full viewport matrix.
    // The blend-mode is applied HERE (spec §5.1 & §layer_blend_modes_spec §Blend
    // Isolation): the offscreen already carries the per-pixel filter result,
    // so blending against the backdrop is the last step and never poisons the
    // downstream backdrop with un-filtered pixels.
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
    // [Coordinate Translation Rationale]
    // The layer's world matrix applied to ctx compensates for the visible shape offset by shifting (-vx, -vy).
    // To counteract this shift and align the offscreen canvas (where the feathered fragment sits at 0,0) with
    // the layer's correct layout and hit-test boundaries, we must draw the offscreen canvas at (vx, vy).
    ctx.drawImage(offscreen, vx, vy, layer.bounding.w, layer.bounding.h);
    ctx.restore();
  } else {
    // ═══════════════════════════════════════════════════════════════════════════
    // STANDARD PATH: Direct rendering with ctx.clip() (zero overhead when no feather)
    // ═══════════════════════════════════════════════════════════════════════════
    ctx.save();

    // 1. Inject geometric transformations
    if (matrix) {
      ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);
    }

    // 2. Inject style context
    ctx.imageSmoothingEnabled = false;
    ctx.imageSmoothingQuality = imageSmoothingQuality;
    ctx.filter = getAdjustmentsData(layer.adjustments);
    ctx.globalAlpha = (opacity ?? layer.opacity) * (layer.fill ?? 1);
    ctx.globalCompositeOperation = (layer.blendMode || 'source-over') as GlobalCompositeOperation;

    // 3. Inject mask clipping sequence (all hard-edge since no feather)
    applyClipSequence(ctx, layer, clipSequence || []);

    // 4. Execute pixel drawing
    drawLayerContent(ctx, layer, source, drawRect, dprScale, tileCount);

    ctx.restore();
  }
}


/**
 * drawLayerContent: Internal helper that draws the actual layer pixels.
 * Extracted to avoid duplication between the standard path and the feathered offscreen path.
 */
function drawLayerContent(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: Layer,
  source: CanvasImageSource | ImageBitmap | TileData[] | null | undefined,
  drawRect: { x: number, y: number, w: number, h: number } | undefined,
  dprScale: number | undefined,
  tileCount: number | undefined
) {
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
        // Path-type visibleShapes (polygon-derived, e.g. from inverted selections
        // via fragmentToLayerLogical) require 'evenodd' to produce correct holes.
        ctx.clip(path, layer.visibleShape.type === 'path' ? 'evenodd' : 'nonzero');
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

