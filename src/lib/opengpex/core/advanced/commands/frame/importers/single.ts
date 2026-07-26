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

import { asLocalShape, EditorContextValue } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { VIEWPORT_FIT_PADDING } from '@opengpex/editor/core/helpers/presets';
import type { DecodeResult } from '@opengpex/editor/core/files/types';
import type { ImportOptions } from './_types';

/**
 * Import a single image as a new frame with one layer.
 *
 * @param ctx - Editor context
 * @param decoded - Decoded image result from FileService
 * @param file - Original source file (for name/metadata)
 * @param sourceType - How the file was obtained ('local' | 'url')
 * @param opts - Import options (switchFrame, dpi, extra)
 * @returns Frame ID of the created frame.
 */
export async function importSingleImage(
  ctx: EditorContextValue,
  decoded: DecodeResult,
  file: File,
  sourceType: 'local' | 'url',
  opts: ImportOptions,
): Promise<string> {
  const { assets, pixels, actions, state, geometry } = ctx;
  const { switchFrame, dpi: chosenFrameDpi, extra, parentId, seqNum, nameOverride } = opts;
  const { dimensions: decodeDimensions, metadata, sourceBlob, subImages } = decoded;

  const displayBlob = subImages[0].displayBlob;

  // 1. Register original asset (pass sourceBlob for 16-bit fidelity preservation)
  const { id: assetId, url: assetUrl } = await assets.register(displayBlob, sourceBlob ? { rawBlob: sourceBlob } : undefined);

  // 2. Concurrently: decode content bounds + generate thumbnail
  const [contentBounds, thumbBlob] = await Promise.all([
    pixels.image.contentBounds(assetUrl),
    (await pixels.image.resample(assetUrl, { maxSize: 256 })).toBlob('image/webp'),
  ]);
  const dimension = decodeDimensions;

  // 3. Register thumbnail asset
  const { id: thumbAssetId, url: thumbAssetUrl } = await assets.register(thumbBlob);

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

  // Detect bit depth from source image metadata (immutable after creation)
  const detectedBitDepth: 8 | 16 | 32 = metadata.bitDepth >= 32 ? 32 : metadata.bitDepth > 8 ? 16 : 8;

  const frame = LayerFactory.getNewFrame({
    id: `f-${Date.now().toString(36)}-${parentId ? 'branch' : 'trunk'}`,
    parentId,
    seqNum,
    name: nameOverride || frameName || file.name,
    canvas: dimension,
    dpi: chosenFrameDpi || metadata.dpi,
    bitDepth: detectedBitDepth,
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
