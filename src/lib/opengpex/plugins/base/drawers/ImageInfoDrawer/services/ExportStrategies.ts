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
 * Export Strategies — Encapsulates the actual blob-production logic for each export path.
 *
 * The download command dispatches to one of these strategies based on format,
 * bit-depth eligibility, and layer count. Each strategy returns a Blob.
 */

import type { EditorContextValue } from '@opengpex/editor/core/types';
import type { ImageMetadata, EncodeOptions } from '@opengpex/editor/core/files';
import type { Frame, LocalShape } from '@opengpex/editor/core/types';
import { assetStore } from '@opengpex/editor/core/storage/asset/AssetStore';
import { exportHighRes, compositeMultiLayer16bit } from '@opengpex/editor/core/files/handlers/tiff';
import { mapBlendMode } from '@opengpex/editor/core/files/blendModeMap';

import { FormatConverter } from './FormatConverter';
import type * as P from '../protocols';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ExportParams {
  ctx: EditorContextValue;
  activeFrame: Frame;
  config: P.ExportConfig;
  cropBox?: LocalShape | undefined;
  isClipMode: boolean;
  exportW: number;
  exportH: number;
  dpi: number;
  layerMeta?: ImageMetadata;
}

// ─── Strategy: 16-bit Single Layer Export ───────────────────────────────────────

/**
 * Exports a single layer in 16-bit via the high-resolution vips pipeline.
 * Prerequisites: single visible layer, regular rect crop, rawBlob available.
 *
 * @returns Blob if successful, or null if conditions not met (caller should fallback)
 */
export async function exportSingleLayer16bit(params: ExportParams): Promise<Blob | null> {
  const { activeFrame, config, cropBox, isClipMode, exportW, exportH, dpi } = params;

  // Format eligibility
  const is16bitFormat = config.format === 'image/tiff' || config.format === 'image/png';
  if (!is16bitFormat) return null;

  // Source bit-depth check
  const baseLayer = activeFrame.layers.byId[activeFrame.layers.order[0]];
  const sourceBitDepth = (baseLayer?.metadata?.imageMetadata as { bitDepth?: number } | undefined)?.bitDepth ?? 8;
  if (sourceBitDepth <= 8) return null;

  // User preference check
  const wantHighBit = config.exportBitDepth !== 8;
  if (!wantHighBit) return null;

  // Asset ID check
  if (!baseLayer?.assetId) return null;

  // Single visible layer check
  const visibleContentLayers = activeFrame.layers.order.filter(id => {
    const l = activeFrame.layers.byId[id];
    return !l.hostId && l.visible !== false;
  });
  if (visibleContentLayers.length !== 1) return null;

  // Regular rect crop check (irregular polygon clips require Canvas2D)
  const isRegularCrop = !cropBox || cropBox.type === 'rect';
  if (!isRegularCrop) return null;

  // Raw blob availability check
  const rawBlob = await assetStore.getRaw(baseLayer.assetId);
  if (!rawBlob) return null;

  console.debug('[ExportStrategy] %d-bit source detected, using high-res export pipeline', sourceBitDepth);

  // Determine crop parameters for vips
  const needsCrop = isClipMode && cropBox;
  const crop = needsCrop ? {
    x: Math.round(cropBox.rect.x),
    y: Math.round(cropBox.rect.y),
    w: Math.round(cropBox.rect.w),
    h: Math.round(cropBox.rect.h),
  } : undefined;

  // Determine resize
  const sourceW = crop ? crop.w : activeFrame.canvas.w;
  const sourceH = crop ? crop.h : activeFrame.canvas.h;
  const needsResize = exportW !== sourceW || exportH !== sourceH;
  const resize = needsResize ? { w: exportW, h: exportH } : undefined;

  return exportHighRes(rawBlob, {
    format: config.format === 'image/png' ? 'png' : 'tiff',
    compression: config.tiffCompression || 'none',
    pngCompression: config.pngCompression ?? 6,
    dpi,
    crop,
    resize,
  });
}

// ─── Strategy: Standard 8-bit Export ────────────────────────────────────────────

/**
 * Standard 8-bit export path: renders via Canvas2D and encodes to the target format.
 * Handles AVIF (via FormatConverter), TIFF (via TiffHandler), and all other formats.
 */
export async function exportStandard8bit(params: ExportParams): Promise<Blob> {
  const { ctx, activeFrame, config, cropBox, isClipMode, dpi, layerMeta } = params;
  const { pixels, files } = ctx;

  if (config.format === 'image/avif') {
    // AVIF: dedicated worker path
    return FormatConverter.export(ctx, {
      format: config.format,
      quality: config.quality,
      isClipMode: !!(isClipMode && cropBox),
      cropBox,
    });
  }

  if (config.format === 'image/tiff') {
    // TIFF 8-bit: render raw bitmap → TiffHandler.encode
    const bitmap = (isClipMode && cropBox
      ? await pixels.render.shapeToBlob(activeFrame, cropBox, { format: 'raw', quality: 1 })
      : await pixels.render.frameToBlob(activeFrame, { format: 'raw', quality: 1 })) as ImageBitmap;

    return files.encode(bitmap, config.format, {
      quality: 1,
      tiffCompression: config.tiffCompression || 'none',
      jpegQuality: config.jpegQuality,
      tiffPredictor: config.tiffPredictor,
      tiffBigtiff: config.tiffBigtiff,
      tiffTile: config.tiffTile,
      tiffTileWidth: config.tiffTileWidth,
      tiffTileHeight: config.tiffTileHeight,
      metadata: layerMeta,
      exportConfig: {
        dpi,
        writeSoftwareTag: true,
      },
    } as EncodeOptions & { tiffCompression?: string; jpegQuality?: number; tiffPredictor?: string; tiffBigtiff?: boolean; tiffTile?: boolean; tiffTileWidth?: number; tiffTileHeight?: number });
  }

  // JPEG/PNG/BMP/WebP: render raw bitmap → files.encode (unified metadata injection)
  const bitmap = (isClipMode && cropBox
    ? await pixels.render.shapeToBlob(activeFrame, cropBox, { format: 'raw', quality: 1 })
    : await pixels.render.frameToBlob(activeFrame, { format: 'raw', quality: 1 })) as ImageBitmap;

  return files.encode(bitmap, config.format, {
    quality: config.quality ? config.quality / 100 : 0.92,
    metadata: layerMeta,
    exportConfig: {
      dpi,
      preserveExif: config.keepExif,
      writeSoftwareTag: true,
    },
  });
}

// ─── Strategy: Multi-layer 16-bit Composite Export ──────────────────────────────

/**
 * Exports multiple layers composited in 16-bit via vips.
 *
 * Prerequisites:
 * - Format is TIFF or PNG
 * - User wants 16-bit (exportBitDepth !== 8)
 * - At least one layer has a rawBlob (16-bit source)
 * - Regular rect crop (no irregular polygon)
 *
 * For layers without raw source, their 8-bit display asset is upsampled.
 *
 * @returns Blob if successful, or null if conditions not met (caller should fallback)
 */
export async function exportMultiLayer16bit(params: ExportParams): Promise<Blob | null> {
  const { ctx, activeFrame, config, cropBox, isClipMode, dpi } = params;
  const { assets } = ctx;

  // Format eligibility
  const is16bitFormat = config.format === 'image/tiff' || config.format === 'image/png';
  if (!is16bitFormat) return null;

  // User preference check
  const wantHighBit = config.exportBitDepth !== 8;
  if (!wantHighBit) return null;

  // Regular rect crop check (irregular polygon clips require Canvas2D rasterization)
  const isRegularCrop = !cropBox || cropBox.type === 'rect';
  if (!isRegularCrop) return null;

  // Collect visible content layers (bottom → top)
  const visibleContentLayerIds = activeFrame.layers.order.filter(id => {
    const l = activeFrame.layers.byId[id];
    return !l.hostId && l.visible !== false;
  });

  if (visibleContentLayerIds.length < 1) return null;

  // Check if at least one layer has 16-bit raw source
  let hasAny16bit = false;
  for (const id of visibleContentLayerIds) {
    const layer = activeFrame.layers.byId[id];
    if (layer.assetId) {
      const hasRaw = await assetStore.hasRaw(layer.assetId);
      if (hasRaw) { hasAny16bit = true; break; }
    }
  }
  if (!hasAny16bit) return null;

  console.debug('[ExportStrategy] Multi-layer 16-bit composite: %d visible layers', visibleContentLayerIds.length);

  // Build layer descriptors for vips composite
  const layerDescriptors: Array<{
    bytes: Uint8Array; x: number; y: number; blendMode: string; opacity: number; is8bit: boolean;
  }> = [];

  for (const id of visibleContentLayerIds) {
    const layer = activeFrame.layers.byId[id];
    if (!layer.assetId) continue;

    // Try to get raw 16-bit source first
    const rawBlob = await assetStore.getRaw(layer.assetId);
    let bytes: Uint8Array;
    let is8bit: boolean;

    if (rawBlob) {
      // 16-bit source available
      const buf = await rawBlob.arrayBuffer();
      bytes = new Uint8Array(buf);
      is8bit = false;
    } else {
      // Fallback: use 8-bit display asset (will be upsampled by vips)
      const entry = assets.get(layer.assetId);
      if (!entry?.blob) continue;
      const buf = await entry.blob.arrayBuffer();
      bytes = new Uint8Array(buf);
      is8bit = true;
    }

    // Calculate layer position on canvas
    const x = layer.cx ?? 0;
    const y = layer.cy ?? 0;

    // Map blend mode
    const blendMode = mapBlendMode(layer.blendMode);

    // Layer opacity (fill * opacity)
    const opacity = (layer.opacity ?? 1) * (layer.fill ?? 1);

    layerDescriptors.push({ bytes, x, y, blendMode, opacity, is8bit });
  }

  if (layerDescriptors.length === 0) return null;

  // Determine canvas dimensions (may be cropped)
  const canvasW = isClipMode && cropBox ? Math.round(cropBox.rect.w) : activeFrame.canvas.w;
  const canvasH = isClipMode && cropBox ? Math.round(cropBox.rect.h) : activeFrame.canvas.h;

  // If cropping, adjust layer positions relative to crop origin
  if (isClipMode && cropBox) {
    const cropX = Math.round(cropBox.rect.x);
    const cropY = Math.round(cropBox.rect.y);
    for (const desc of layerDescriptors) {
      desc.x -= cropX;
      desc.y -= cropY;
    }
  }

  // Execute vips composite
  return compositeMultiLayer16bit(layerDescriptors, canvasW, canvasH, {
    format: config.format === 'image/png' ? 'png' : 'tiff',
    compression: config.tiffCompression || 'lzw',
    dpi,
    jpegQuality: config.jpegQuality,
    bigtiff: config.tiffBigtiff,
    tile: config.tiffTile,
    tileWidth: config.tiffTileWidth,
    tileHeight: config.tiffTileHeight,
  });
}
