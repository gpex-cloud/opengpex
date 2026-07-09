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
 * Single Image Import Strategy.
 *
 * Creates a single-layer frame from a decoded single-page image.
 * Handles asset registration, thumbnail generation, camera calculation,
 * and frame assembly.
 */

'use client';

import { asLocalShape } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { VIEWPORT_FIT_PADDING } from '@opengpex/editor/core/helpers/presets';
import type { ImportContext } from './types';

/**
 * Import a single image as a new frame with one layer.
 *
 * @returns Frame ID of the created frame.
 */
export async function importSingleImage(importCtx: ImportContext): Promise<string> {
  const { ctx, file, decoded, sourceType, switchFrame, chosenFrameDpi, extra } = importCtx;
  const { assets, pixels, actions, state, geometry } = ctx;
  const { dimensions: decodeDimensions, metadata, sourceBlob, subImages } = decoded;

  const displayBlob = subImages[0].displayBlob;

  // 1. Register original asset (pass sourceBlob for 16-bit fidelity preservation)
  const assetId = await assets.register(displayBlob, sourceBlob ? { rawBlob: sourceBlob } : undefined);
  const assetUrl = assets.getURL(assetId)!;

  // 2. Concurrently: decode content bounds + generate thumbnail
  const [contentBounds, thumbBlob] = await Promise.all([
    pixels.decode.contentBounds(assetUrl),
    pixels.process.thumbnail(assetUrl, 256),
  ]);
  const dimension = decodeDimensions;

  // 3. Register thumbnail asset
  const thumbAssetId = await assets.register(thumbBlob);
  const thumbAssetUrl = assets.getURL(thumbAssetId)!;

  // 4. Construct initial environment and camera calculation
  const { insets } = state.ui.theme.config;
  const initialCamera = geometry.camera.getFitCamera(
    state.ui.viewportDim,
    dimension,
    { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
  );
  const defaultCanvasCropBox = asLocalShape({ x: dimension.w * 0.25, y: dimension.h * 0.25, w: dimension.w * 0.5, h: dimension.h * 0.5 });

  // 5. Assemble domain entities
  const blobType = displayBlob instanceof File ? displayBlob.type : (displayBlob.type || 'image/png');
  const blobSize = displayBlob.size;
  const baseLayer = LayerFactory.getNewLayer({
    name: 'Background',
    src: assetUrl,
    assetId,
    cx: 0,
    cy: 0,
    locked: true,
    bounding: dimension,
    visibleShape: asLocalShape(contentBounds),
    metadata: { format: blobType, size: blobSize, source: sourceType, originalName: file.name, imageMetadata: metadata },
  });

  const expandedLayers = LayerFactory.expandLayers([baseLayer]);

  // Use original file name so HEIC/RAW/SVG keep their original names
  const frameName = file.name.replace(/\.[^.]+$/, '');
  const frame = LayerFactory.getNewFrame({
    id: `f-${Date.now().toString(36)}-trunk`,
    name: frameName || file.name,
    canvas: dimension,
    dpi: chosenFrameDpi || metadata.dpi,
    layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
    activeLayerId: baseLayer.id,
    camera: initialCamera,
    canvasCropBox: defaultCanvasCropBox,
    assetId,
    thumbnail: { src: thumbAssetUrl, assetId: thumbAssetId },
    extra,
  });

  actions.addFrame(frame, switchFrame);
  return frame.id;
}
