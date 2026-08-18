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
 * Architecture:
 *   - `buildFrameContent` — Pure content builder (layers, camera, metadata).
 *     Shared by both importSingleImage (new frame) and revert (in-place rebuild).
 *   - `importSingleImage` — Creates a new frame and adds it to the store.
 */

'use client';

import { asLocalShape, EditorContextValue, WorkingColorSpace, Layer, NormalizedState, CameraState, LocalShape } from '@opengpex/editor/core/types';
import { getDefaultCanvasCropBox } from '@opengpex/editor/core/helpers/selection';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { presets } from '@opengpex/editor/core/helpers/preferences';
const VIEWPORT_FIT_PADDING = presets.get('VIEWPORT_FIT_PADDING');
import { resolveColorSpaceForFormat, getImportStrategy } from '@opengpex/editor/core/color/ColorPipeline';
import type { DecodeResult } from '@opengpex/editor/core/files/types';
import type { Dimensions } from '@opengpex/editor/core/types';
import type { ImportOptions } from './_types';

// ═══════════════════════════════════════════════════════════════════════════════
// BuildFrameContent — Pure content builder (reusable by import + revert)
// ═══════════════════════════════════════════════════════════════════════════════

/** Output of buildFrameContent — everything needed to create or update a frame. */
export interface FrameContent {
  layers: NormalizedState<Layer>;
  activeLayerId: string;
  canvas: Dimensions;
  camera: CameraState;
  canvasCropBox: LocalShape;
  assetId: string;
  thumbnail: { src: string; assetId: string };
  dpi: number;
  bitDepth: 8 | 16 | 32;
  colorSpace: WorkingColorSpace;
}

/**
 * Builds frame content from a decoded image — layers, camera, metadata.
 *
 * This is the shared core used by both `importSingleImage` (new frame creation)
 * and `revert` (in-place frame rebuild). It does NOT touch the store — it only
 * produces the data needed to construct or update a frame.
 *
 * @param ctx - Editor context (for asset registration, pixel ops, geometry)
 * @param decoded - Decoded image result from FileService
 * @param file - Original source file (for name/metadata)
 * @param sourceType - How the file was obtained ('local' | 'url')
 * @param chosenDpi - Optional DPI override (from vector dialog or import options)
 * @returns FrameContent — all data needed to create/update a frame
 */
export async function buildFrameContent(
  ctx: EditorContextValue,
  decoded: DecodeResult,
  file: File,
  sourceType: 'local' | 'url',
  chosenDpi?: number,
): Promise<FrameContent> {
  const { assets, pixels, state, geometry } = ctx;
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

  // 4. Camera calculation
  const { insets } = state.ui.theme.config;
  const camera = geometry.camera.getFitCamera(
    state.ui.viewportDim,
    dimension,
    { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
  );
  const canvasCropBox = getDefaultCanvasCropBox(dimension);

  // 5. Assemble base layer
  const blobType = displayBlob instanceof File ? displayBlob.type : (displayBlob.type || 'image/png');
  const blobSize = displayBlob.size;
  const baseLayer = LayerFactory.getNewLayer({
    name: 'Background',
    src: assetUrl,
    assetId,
    cx: 0,
    cy: 0,
    locked: true,
    isSource: true,
    bounding: dimension,
    visibleShape: asLocalShape(contentBounds),
    metadata: { format: blobType, size: blobSize, source: sourceType, originalName: file.name, imageMetadata: metadata },
  });

  const expandedLayers = LayerFactory.expandLayers([baseLayer]);

  // 6. Detect bit depth and color space
  const detectedBitDepth: 8 | 16 | 32 = metadata.bitDepth >= 32 ? 32 : metadata.bitDepth > 8 ? 16 : 8;
  const detectedCS = resolveColorSpaceForFormat(metadata.sourceFormat, metadata.colorSpace);
  const strategy = getImportStrategy(detectedCS);
  const colorSpace: WorkingColorSpace = strategy.frameColorSpace;

  return {
    layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
    activeLayerId: baseLayer.id,
    canvas: dimension,
    camera,
    canvasCropBox,
    assetId,
    thumbnail: { src: thumbAssetUrl, assetId: thumbAssetId },
    dpi: chosenDpi || metadata.dpi,
    bitDepth: detectedBitDepth,
    colorSpace,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// importSingleImage — Creates a new frame and adds to store
// ═══════════════════════════════════════════════════════════════════════════════

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
): Promise<{ frameId: string; thumbnailUrl: string }> {
  const { actions } = ctx;
  const { switchFrame, dpi: chosenFrameDpi, extra, parentId, seqNum, nameOverride } = opts;

  // Build all frame content (layers, camera, metadata)
  const content = await buildFrameContent(ctx, decoded, file, sourceType, chosenFrameDpi);

  // Derive frame name
  const frameName = file.name.replace(/\.[^.]+$/, '');

  // Assemble and add the frame
  const frame = LayerFactory.getNewFrame({
    id: `f-${Date.now().toString(36)}-${parentId ? 'branch' : 'trunk'}`,
    parentId,
    seqNum,
    name: nameOverride || frameName || file.name,
    source: file.name,
    canvas: content.canvas,
    dpi: content.dpi,
    bitDepth: content.bitDepth,
    colorSpace: content.colorSpace,
    trc: 'srgb-trc',
    layers: content.layers,
    activeLayerId: content.activeLayerId,
    camera: content.camera,
    canvasCropBox: content.canvasCropBox,
    assetId: content.assetId,
    thumbnail: content.thumbnail,
    extra,
  });

  actions.addFrame(frame, switchFrame);
  return { frameId: frame.id, thumbnailUrl: content.thumbnail.src };
}
