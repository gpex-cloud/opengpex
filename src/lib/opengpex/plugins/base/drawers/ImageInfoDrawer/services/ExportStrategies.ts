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
import { exportHighRes } from '@opengpex/editor/core/files/handlers/tiff';

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
      metadata: layerMeta,
      exportConfig: {
        dpi,
        writeSoftwareTag: true,
      },
    } as EncodeOptions & { tiffCompression?: string });
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
