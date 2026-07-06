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
 * handlers/transformer.ts: Transformation and baking handlers
 */

import { workerCache } from '../core/WorkerCache';
import { PixelUtils } from '../../PixelUtils';
import { ShapeType, WorkerResult, VectorMask, Layer, ClipDescriptor, asLocalShape } from '@opengpex/editor/core/types';
import { EngineProvider } from '../core/EngineProvider';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';
import { shrinkInvertedMask } from '@opengpex/editor/core/helpers/sub-pixel';

export async function cloneAssetRegion(hash: string, rect: { x: number; y: number; w: number; h: number }, shape?: ShapeType): Promise<WorkerResult> {
  const levels = workerCache.getBitmaps(hash);
  if (!levels || !levels[0]) {
    throw new Error(`Asset ${hash} not in worker cache for cloning`);
  }
  
  const source = levels[0];
  const offscreen = new OffscreenCanvas(rect.w, rect.h);
  const offCtx2d = offscreen.getContext('2d')!;

  const dummyLayer: Partial<Layer> = {
    type: 'image',
    bounding: { w: source.width, h: source.height },
    opacity: 1
  };

  const circleShape = asLocalShape({ x: rect.x, y: rect.y, w: rect.w, h: rect.h }, 'circle');
  const clipSequence: ClipDescriptor[] | undefined = shape === 'circle' ? [{
    shape: circleShape,
    inverted: false,
    __compiledPath2D: shapeToPath2D(circleShape)
  }] : undefined;

  EngineProvider.drawLayerInstance(offCtx2d, dummyLayer as Layer, source, {
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: -rect.x, ty: -rect.y },
    clipSequence
  });

  const blob = await PixelUtils.canvasToBlob(offscreen);
  return PixelUtils.wrapResult(blob);
}

export async function bakeAssetMasks(hash: string, masks: VectorMask[]): Promise<WorkerResult> {
  const bitmaps = workerCache.getBitmaps(hash);
  if (!bitmaps || !bitmaps[0]) throw new Error(`Asset ${hash} not in worker cache for baking`);
  
  const source = bitmaps[0];
  const { width, height } = source;
  
  const offscreen = new OffscreenCanvas(width, height);
  const offCtx2d = offscreen.getContext('2d')!;

  const dummyLayer: Partial<Layer> = {
    type: 'image',
    bounding: { w: width, h: height },
    opacity: 1
  };

  const clipSequence = masks.map(m => ({
    shape: m.shape,
    inverted: m.inverted,
    feather: m.feather || 0,
    __compiledPath2D: shapeToPath2D(shrinkInvertedMask(m.shape, m.inverted))
  })) as ClipDescriptor[];

  EngineProvider.drawLayerInstance(offCtx2d, dummyLayer as Layer, source, {
    clipSequence
  });

  const blob = await PixelUtils.canvasToBlob(offscreen);
  return PixelUtils.wrapResult(blob);
}

export async function resampleImage(src: string, targetSize: { w: number; h: number }, options?: { format?: string; quality?: number }): Promise<WorkerResult> {
  // console.log(`[Worker] resampleImage called for ${src}, targetSize:`, targetSize);
  
  const response = await fetch(src);
  const blob = await response.blob();
  const source = await createImageBitmap(blob);
  
  const offscreen = new OffscreenCanvas(targetSize.w, targetSize.h);
  const ctx = offscreen.getContext('2d', { alpha: options?.format !== 'image/jpeg' })!;
  
  // Apply context state inside worker (this aligns with our unified setup goal)
  ctx.imageSmoothingEnabled = false;
  ctx.imageSmoothingQuality = 'high';

  if (options?.format === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetSize.w, targetSize.h);
  }
  
  ctx.drawImage(source, 0, 0, targetSize.w, targetSize.h);
  
  const resultBlob = await PixelUtils.canvasToBlob(offscreen, options?.format, options?.quality);
  return PixelUtils.wrapResult(resultBlob);
}
