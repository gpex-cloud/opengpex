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
 * Multi-page TIFF Import Strategy.
 *
 * Handles TIFF files with multiple pages — user chooses between
 * importing all pages as layers or only the first page.
 */

'use client';

import { asLocalShape, Layer, EditorContextValue } from '@opengpex/editor/core/types';
import { getDefaultCanvasCropBox } from '@opengpex/editor/core/helpers/selection';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { presets } from '@opengpex/editor/core/helpers/preferences';
const VIEWPORT_FIT_PADDING = presets.get('VIEWPORT_FIT_PADDING');
import type { DecodeResult } from '@opengpex/editor/core/files/types';
import type { ImportOptions } from './_types';

/**
 * Import multi-page TIFF as multiple layers or first-page-only.
 *
 * @returns Frame ID if imported as layers, '' if user cancelled,
 *          or null to indicate "fall through to single-image import" (first page only).
 */
export async function importMultiPageTiff(
  ctx: EditorContextValue,
  decoded: DecodeResult,
  file: File,
  opts: ImportOptions,
): Promise<string | null> {
  const { assets, actions, state, geometry } = ctx;
  const { switchFrame, dpi: chosenFrameDpi } = opts;
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

  const dimension = decodeDimensions;

  const pageAssets = await Promise.all(
    subImages.map(async (p) => {
      const { id: assetId, url: assetUrl } = await assets.register(p.displayBlob, { w: p.width, h: p.height });
      return { assetId, assetUrl, width: p.width, height: p.height, index: p.index };
    }),
  );

  const pageLayers: Layer[] = pageAssets.map((pa, i) => {
    const pageDim = { w: pa.width, h: pa.height };
    return LayerFactory.getNewLayer({
      name: `Page ${i + 1}`,
      src: pa.assetUrl,
      assetId: pa.assetId,
      cx: 0,
      cy: 0,
      locked: false,
      visible: i === 0,
      opacity: 1,
      bounding: pageDim,
      visibleShape: asLocalShape({ x: 0, y: 0, w: pageDim.w, h: pageDim.h }),
    });
  });

  const expandedPageLayers = pageLayers.flatMap(l => LayerFactory.expandLayers([l]));

  const { insets } = state.ui.theme.config;
  const tiffCamera = geometry.camera.getFitCamera(
    state.ui.viewportDim,
    dimension,
    { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
  );

  const detectedBitDepth: 8 | 16 | 32 = metadata.bitDepth >= 32 ? 32 : metadata.bitDepth > 8 ? 16 : 8;

  const tiffFrame = LayerFactory.getNewFrame({
    id: `f-${Date.now().toString(36)}-trunk`,
    name: file.name.replace(/\.[^.]+$/, ''),
    source: file.name,
    canvas: dimension,
    dpi: chosenFrameDpi || metadata.dpi || 300,
    bitDepth: detectedBitDepth,
    layers: { byId: Object.fromEntries(expandedPageLayers.map(l => [l.id, l])), order: expandedPageLayers.map(l => l.id) },
    activeLayerId: pageLayers[0].id,
    camera: tiffCamera,
    canvasCropBox: getDefaultCanvasCropBox(dimension),
    assetId: pageAssets[0].assetId,
    metadata,
  });

  actions.addFrame(tiffFrame, switchFrame);
  actions.notifyHUD(`Imported ${pageCount}-page TIFF as ${pageCount} layers`, 'success');
  return tiffFrame.id;
}
