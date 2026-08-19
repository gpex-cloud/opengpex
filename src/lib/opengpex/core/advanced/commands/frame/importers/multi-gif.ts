/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Animated GIF Import Strategy.
 *
 * Architecture:
 *   - `buildGifFrameContent` — Pure content builder (layers, camera, frame count dialog).
 *     Shared by both importAnimatedGif (new frame) and revertGifFrame (in-place rebuild).
 *   - `importAnimatedGif` — Creates a new GIF frame and adds it to the store.
 */

'use client';

import { asLocalShape, Layer, EditorContextValue, NormalizedState, CameraState, LocalShape, Dimensions } from '@opengpex/editor/core/types';
import type { ImageMetadata } from '@opengpex/editor/core/files/types';
import { getDefaultCanvasCropBox } from '@opengpex/editor/core/helpers/selection';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { presets } from '@opengpex/editor/core/helpers/preferences';
const VIEWPORT_FIT_PADDING = presets.get('VIEWPORT_FIT_PADDING');
import type { DecodeResult } from '@opengpex/editor/core/files/types';
import type { ImportOptions } from './_types';

// ═══════════════════════════════════════════════════════════════════════════════
// buildGifFrameContent — Pure GIF content builder (shared by import + revert)
// ═══════════════════════════════════════════════════════════════════════════════

/** Output of buildGifFrameContent — everything needed to create or update a GIF frame. */
export interface GifFrameContent {
  layers: NormalizedState<Layer>;
  activeLayerId: string;
  canvas: Dimensions;
  camera: CameraState;
  canvasCropBox: LocalShape;
  gifSequenceId: string;
  gifFrameCount: number;
  metadata?: ImageMetadata;
}

/**
 * Builds GIF frame content from a decoded GIF — frame selection dialog, layers, camera.
 *
 * Shared by both `importAnimatedGif` (new frame) and `revertGifFrame` (in-place rebuild).
 * Includes the frame count selection dialog (user interactive).
 * Returns null if user cancelled the dialog.
 */
export async function buildGifFrameContent(
  ctx: EditorContextValue,
  decoded: DecodeResult,
): Promise<GifFrameContent | null> {
  const { assets, actions, state, geometry } = ctx;
  const { dimensions: decodeDimensions, metadata, subImages } = decoded;

  let framesToImport = subImages;
  const totalFrames = framesToImport.length;
  const GIF_DEFAULT_LIMIT = 30;

  // Frame count selection dialog (user can cancel → returns null)
  if (totalFrames > GIF_DEFAULT_LIMIT) {
    const targetCounts = [10, 20, 30, 60, 100].filter(n => n < totalFrames);
    const limitOptions = targetCounts.map(target => {
      const step = Math.ceil(totalFrames / target);
      let actualCount = 0;
      for (let i = 0; i < totalFrames; i += step) actualCount++;
      return { id: String(step), label: `${actualCount} frames`, description: `Keep 1 of every ${step} frames` };
    }).filter((opt, idx, arr) => idx === 0 || opt.label !== arr[idx - 1].label);

    limitOptions.push({ id: '1', label: `All ${totalFrames} frames`, description: 'May use significant memory' });

    const chosenStep = await actions.askChoice(
      `GIF has ${totalFrames} frames`, limitOptions,
      `This animated GIF contains ${totalFrames} frames. Importing all frames may use significant memory. Choose a frame limit for decimation (sampled frames will preserve animation timing).`,
    );
    if (!chosenStep) return null; // User cancelled

    const step = parseInt(chosenStep, 10) || 1;
    if (step > 1) {
      const sampled: typeof framesToImport = [];
      for (let i = 0; i < totalFrames; i += step) {
        const si = framesToImport[i];
        sampled.push({ ...si, delay: (si.delay || 100) * step, index: sampled.length });
      }
      framesToImport = sampled;
      actions.notifyHUD(`Decimated: ${totalFrames} → ${sampled.length} frames (step=${step})`, 'info');
    }
  }

  // Register frame assets + build layers
  const dimension = decodeDimensions;
  const gifSequenceId = `gif-seq-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 6)}`;

  const frameAssets = await Promise.all(
    framesToImport.map(async (f) => {
      const { id: assetId, url: assetUrl } = await assets.register(f.displayBlob, dimension);
      return { assetId, assetUrl, delay: f.delay || 100, index: f.index };
    }),
  );

  const frameLayers: Layer[] = frameAssets.map((fa, i) => LayerFactory.getNewLayer({
    name: `Frame ${i + 1}`,
    src: fa.assetUrl,
    assetId: fa.assetId,
    cx: 0, cy: 0,
    locked: false,
    visible: i === 0,
    bounding: dimension,
    visibleShape: asLocalShape({ x: 0, y: 0, w: dimension.w, h: dimension.h }),
    metadata: {
      gifSequenceId,
      gifFrameIndex: i, gifFrameDelay: fa.delay, gifTotalFrames: framesToImport.length,
    },
  }));

  const expandedLayers = frameLayers.flatMap(l => LayerFactory.expandLayers([l]));

  // Camera calculation
  const { insets } = state.ui.theme.config;
  const camera = geometry.camera.getFitCamera(
    state.ui.viewportDim, dimension,
    { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
  );

  return {
    layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
    activeLayerId: frameLayers[0].id,
    canvas: dimension,
    camera,
    canvasCropBox: getDefaultCanvasCropBox(dimension),
    gifSequenceId,
    gifFrameCount: framesToImport.length,
    metadata,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// importAnimatedGif — Creates new frame from GIF (uses buildGifFrameContent)
// ═══════════════════════════════════════════════════════════════════════════════

export async function importAnimatedGif(
  ctx: EditorContextValue,
  decoded: DecodeResult,
  file: File,
  _sourceType: 'local' | 'url',
  opts: ImportOptions,
): Promise<string> {
  const { assets, pixels, actions } = ctx;
  const { switchFrame, extra } = opts;

  // 1. Build GIF content (includes frame count dialog)
  const content = await buildGifFrameContent(ctx, decoded);
  if (!content) return ''; // User cancelled

  // 2. Store original GIF file as raw source (for future revert)
  const originalGifAssetId = await assets.storeRaw(file);

  // 3. Generate thumbnail
  const firstLayerId = content.layers.order[0];
  const firstLayer = content.layers.byId[firstLayerId];
  const [_contentBounds, thumbResult] = await Promise.all([
    pixels.image.contentBounds(firstLayer.src),
    pixels.image.resample(firstLayer.src, { maxSize: 256 }),
  ]);
  const thumbBlob = await thumbResult.toBlob('image/webp');
  const { id: thumbAssetId, url: thumbAssetUrl } = await assets.register(thumbBlob, thumbResult.dimensions);

  // 4. Assemble and add frame
  const frameName = file.name.replace(/\.[^.]+$/, '');
  const frame = LayerFactory.getNewFrame({
    id: `f-${Date.now().toString(36)}-trunk`,
    name: frameName || file.name,
    source: file.name,
    canvas: content.canvas,
    dpi: decoded.metadata.dpi,
    layers: content.layers,
    activeLayerId: content.activeLayerId,
    camera: content.camera,
    canvasCropBox: content.canvasCropBox,
    assetId: originalGifAssetId,
    thumbnail: { src: thumbAssetUrl, assetId: thumbAssetId },
    extra: { ...extra, gifSequenceId: content.gifSequenceId, gifFrameCount: content.gifFrameCount },
    metadata: content.metadata,
  });

  actions.addFrame(frame, switchFrame);
  actions.notifyHUD(`Imported GIF: ${content.gifFrameCount} frames as layer sequence`, 'success');
  return frame.id;
}
