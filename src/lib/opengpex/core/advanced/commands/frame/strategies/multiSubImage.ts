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
 * Multi Sub-Image Import Strategy.
 *
 * Unified handler for:
 * - Multi-page TIFF → imported as multiple layers or first-page-only
 * - Animated GIF/APNG → imported as frame layers with delay metadata
 *
 * Both paths converge on the same subImages array. The distinction is
 * made by the presence of the `delay` field on SubImage entries.
 */

'use client';

import { asLocalShape, Layer } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { VIEWPORT_FIT_PADDING } from '@opengpex/editor/core/helpers/presets';
import type { ImportContext } from './types';

/**
 * Import multi-sub-image content (multi-page TIFF or animated GIF).
 *
 * @returns Frame ID if imported, '' if user cancelled, or null to indicate
 *          "fall through to single-image import" (TIFF first-page-only mode).
 */
export async function importMultiSubImage(importCtx: ImportContext): Promise<string | null> {
  const { decoded } = importCtx;
  const { subImages } = decoded;

  // Route based on whether sub-images have delay (animation) or not (pages)
  if (subImages[0].delay == null) {
    return importMultiPageTiff(importCtx);
  } else {
    return importAnimatedGif(importCtx);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Multi-page TIFF Import
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Import multi-page TIFF: ask user "As Layers" or "First Page Only".
 *
 * @returns Frame ID if imported as layers, '' if cancelled, null for first-page fallthrough.
 */
async function importMultiPageTiff(importCtx: ImportContext): Promise<string | null> {
  const { ctx, file, decoded, switchFrame, chosenFrameDpi } = importCtx;
  const { assets, actions, state, geometry } = ctx;
  const { dimensions: decodeDimensions, metadata, subImages } = decoded;
  const pageCount = subImages.length;

  const importMode = await actions.askChoice(
    `Multi-page TIFF (${pageCount} pages)`,
    [
      { id: 'layers', label: 'As Layers', description: 'All pages in one frame' },
      { id: 'first', label: 'First Page Only', description: 'Import only the first page' },
    ],
    `This TIFF file contains ${pageCount} pages. How would you like to import them?`,
  );

  if (!importMode) return ''; // User cancelled

  if (importMode === 'first') {
    return null; // Fall through to single-image path
  }

  // Import all pages as layers in one frame
  const dimension = decodeDimensions;

  // Register all page assets concurrently
  const pageAssets = await Promise.all(
    subImages.map(async (p) => {
      const assetId = await assets.register(p.displayBlob);
      const assetUrl = assets.getURL(assetId)!;
      return { assetId, assetUrl, width: p.width, height: p.height, index: p.index };
    }),
  );

  // Create N layers (first page = bottom, last page = top)
  const pageLayers: Layer[] = pageAssets.map((pa, i) => {
    const pageDim = { w: pa.width, h: pa.height };
    return LayerFactory.getNewLayer({
      name: `Page ${i + 1}`,
      src: pa.assetUrl,
      assetId: pa.assetId,
      cx: 0,
      cy: 0,
      locked: false,
      visible: i === 0, // Only first page visible by default
      opacity: 1,
      bounding: pageDim,
      visibleShape: asLocalShape({ x: 0, y: 0, w: pageDim.w, h: pageDim.h }),
      metadata: {
        imageMetadata: {
          ...metadata,
          sourceFileName: `${file.name} (page ${i + 1})`,
        },
      },
    });
  });

  // Expand layers and build normalized structure
  const expandedPageLayers = pageLayers.flatMap(l => LayerFactory.expandLayers([l]));

  // Camera + crop
  const { insets } = state.ui.theme.config;
  const tiffCamera = geometry.camera.getFitCamera(
    state.ui.viewportDim,
    dimension,
    { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
  );

  const tiffFrame = LayerFactory.getNewFrame({
    id: `f-${Date.now().toString(36)}-trunk`,
    name: file.name.replace(/\.[^.]+$/, ''),
    canvas: dimension,
    dpi: chosenFrameDpi || metadata.dpi || 300,
    layers: { byId: Object.fromEntries(expandedPageLayers.map(l => [l.id, l])), order: expandedPageLayers.map(l => l.id) },
    activeLayerId: pageLayers[0].id,
    camera: tiffCamera,
    canvasCropBox: asLocalShape({ x: dimension.w * 0.25, y: dimension.h * 0.25, w: dimension.w * 0.5, h: dimension.h * 0.5 }),
    assetId: pageAssets[0].assetId,
  });

  actions.addFrame(tiffFrame, switchFrame);
  actions.notifyHUD(`Imported ${pageCount}-page TIFF as ${pageCount} layers`, 'success');
  return tiffFrame.id;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Animated GIF Import
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Import animated GIF frames as a layer sequence.
 *
 * Handles frame decimation dialog for large GIFs.
 *
 * @returns Frame ID if imported, '' if user cancelled.
 */
async function importAnimatedGif(importCtx: ImportContext): Promise<string> {
  const { ctx, file, decoded, sourceType, switchFrame, extra } = importCtx;
  const { assets, pixels, actions, state, geometry } = ctx;
  const { dimensions: decodeDimensions, metadata, subImages } = decoded;

  let framesToImport = subImages;
  const totalFrames = framesToImport.length;
  const GIF_DEFAULT_LIMIT = 30;

  // Frame count safety threshold — ask user if frames exceed limit
  if (totalFrames > GIF_DEFAULT_LIMIT) {
    const targetCounts = [10, 20, 30, 60, 100].filter(n => n < totalFrames);
    const limitOptions = targetCounts.map(target => {
      const step = Math.ceil(totalFrames / target);
      let actualCount = 0;
      for (let i = 0; i < totalFrames; i += step) actualCount++;
      return {
        id: String(step),
        label: `${actualCount} frames`,
        description: `Keep 1 of every ${step} frames`,
      };
    }).filter((opt, idx, arr) => {
      return idx === 0 || opt.label !== arr[idx - 1].label;
    });

    limitOptions.push({
      id: '1',
      label: `All ${totalFrames} frames`,
      description: 'May use significant memory',
    });

    const chosenStep = await actions.askChoice(
      `GIF has ${totalFrames} frames`,
      limitOptions,
      `This animated GIF contains ${totalFrames} frames. Importing all frames may use significant memory. Choose a frame limit for decimation (sampled frames will preserve animation timing).`,
    );

    if (!chosenStep) return ''; // User cancelled

    const step = parseInt(chosenStep, 10) || 1;

    if (step > 1) {
      const sampled: typeof framesToImport = [];
      for (let i = 0; i < totalFrames; i += step) {
        const si = framesToImport[i];
        sampled.push({
          ...si,
          delay: (si.delay || 100) * step,
          index: sampled.length,
        });
      }
      framesToImport = sampled;
      actions.notifyHUD(`Decimated: ${totalFrames} → ${sampled.length} frames (step=${step})`, 'info');
    }
  }

  // Register the original GIF file as an asset for future revert support
  const originalGifAssetId = await assets.register(file);

  // Generate a unique sequence ID for this GIF logical group
  const gifSequenceId = `gif-seq-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 6)}`;
  const dimension = decodeDimensions;

  // Register all frame assets concurrently
  const frameAssets = await Promise.all(
    framesToImport.map(async (f) => {
      const assetId = await assets.register(f.displayBlob);
      const assetUrl = assets.getURL(assetId)!;
      return { assetId, assetUrl, delay: f.delay || 100, index: f.index };
    }),
  );

  // Create N frame layers with gifSequenceId metadata
  const frameLayers: Layer[] = frameAssets.map((fa, i) => {
    return LayerFactory.getNewLayer({
      name: `Frame ${i + 1}`,
      src: fa.assetUrl,
      assetId: fa.assetId,
      cx: 0,
      cy: 0,
      locked: false,
      visible: i === 0,
      bounding: dimension,
      visibleShape: asLocalShape({ x: 0, y: 0, w: dimension.w, h: dimension.h }),
      metadata: {
        format: 'image/gif',
        size: file.size,
        source: sourceType,
        originalName: file.name,
        imageMetadata: metadata,
        gifSequenceId,
        gifFrameIndex: i,
        gifFrameDelay: fa.delay,
        gifTotalFrames: framesToImport.length,
      },
    });
  });

  // Expand all layers (triplet structure)
  const expandedLayers = frameLayers.flatMap(l => LayerFactory.expandLayers([l]));

  // Generate thumbnail from first frame
  const firstAssetUrl = frameAssets[0].assetUrl;
  const [_contentBounds, thumbBlob] = await Promise.all([
    pixels.decode.contentBounds(firstAssetUrl),
    pixels.process.thumbnail(firstAssetUrl, 256),
  ]);
  const thumbAssetId = await assets.register(thumbBlob);
  const thumbAssetUrl = assets.getURL(thumbAssetId)!;

  // Camera + crop box
  const { insets } = state.ui.theme.config;
  const initialCamera = geometry.camera.getFitCamera(
    state.ui.viewportDim,
    dimension,
    { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
  );
  const defaultCanvasCropBox = asLocalShape({ x: dimension.w * 0.25, y: dimension.h * 0.25, w: dimension.w * 0.5, h: dimension.h * 0.5 });

  const frameName = file.name.replace(/\.[^.]+$/, '');
  const frame = LayerFactory.getNewFrame({
    id: `f-${Date.now().toString(36)}-trunk`,
    name: frameName || file.name,
    canvas: dimension,
    dpi: metadata.dpi,
    layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
    activeLayerId: frameLayers[0].id,
    camera: initialCamera,
    canvasCropBox: defaultCanvasCropBox,
    assetId: frameAssets[0].assetId,
    thumbnail: { src: thumbAssetUrl, assetId: thumbAssetId },
    extra: { ...extra, gifSequenceId, gifFrameCount: framesToImport.length, originalGifAssetId },
  });

  actions.addFrame(frame, switchFrame);
  actions.notifyHUD(`Imported GIF: ${framesToImport.length} frames as layer sequence`, 'success');
  return frame.id;
}
