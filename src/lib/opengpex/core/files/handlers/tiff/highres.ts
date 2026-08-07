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
 * Public APIs for 16-bit high-resolution export and multi-layer composite.
 *
 * These functions are the public API used by the export command to produce
 * lossless 16-bit TIFF/PNG output from preserved raw sources.
 */

import type { PixelService, AdjustmentState } from '@opengpex/editor/core/types';
import type { TiffCompression } from './encode';

// ═══════════════════════════════════════════════════════════════════════════════
// 16-bit High-Resolution Export
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Options for 16-bit high-resolution export.
 */
export interface HighResExportOptions {
  /** Output format: 'tiff' or 'png' */
  format: 'tiff' | 'png';
  /** TIFF compression: 'none'|'lzw'|'zip' (default: 'lzw') */
  compression?: TiffCompression;
  /** PNG compression level: 0=none/fastest, 6=default, 9=max/slowest (default: 6) */
  pngCompression?: number;
  /** Output DPI (default: 72) */
  dpi?: number;
  /** Optional crop rect (in pixel coordinates of the original image) */
  crop?: { x: number; y: number; w: number; h: number };
  /** Optional resize dimensions */
  resize?: { w: number; h: number };
  /** ICC Profile bytes to embed in output */
  iccProfileBytes?: Uint8Array;
  /**
   * Optional adjustments to apply in 16-bit domain before encoding.
   * Uses AdjustmentState from models.ts — same type as Layer.adjustments.
   * Applied by vips natively — full 16-bit precision, no quantization.
   */
  adjustments?: AdjustmentState;
}

/**
 * Exports a 16-bit high-resolution image from raw source bytes.
 * The entire pipeline runs in 16-bit domain (no quantization to 8-bit).
 *
 * This function is the public API used by the export command to produce
 * lossless 16-bit TIFF/PNG output from preserved raw sources.
 *
 * @param pixels - PixelService instance (provides fileIO namespace)
 * @param rawBlob - The original high-resolution source blob (TIFF/PNG/RAW)
 * @param options - Export options (format, compression, dpi, crop, resize)
 * @returns Blob containing the encoded 16-bit output
 */
export async function exportHighRes(pixels: PixelService, rawBlob: Blob, options: HighResExportOptions): Promise<Blob> {
  const buffer = await rawBlob.arrayBuffer();
  const rawBytes = new Uint8Array(buffer);

  const outputBytes = await pixels.fileIO.exportHighRes(rawBytes, {
    format: options.format,
    compression: options.compression,
    pngCompression: options.pngCompression,
    dpi: options.dpi,
    crop: options.crop,
    resize: options.resize,
    iccProfileBytes: options.iccProfileBytes,
    adjustments: options.adjustments,
  });

  const mimeType = options.format === 'png' ? 'image/png' : 'image/tiff';
  return new Blob([outputBytes.buffer as ArrayBuffer], { type: mimeType });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Multi-layer 16-bit Composite Export
// ═══════════════════════════════════════════════════════════════════════════════

/** Layer descriptor for multi-layer composite export */
export interface CompositeLayerDescriptor {
  /** File bytes (raw 16-bit source or 8-bit display PNG) */
  bytes: Uint8Array;
  /** Layer X position on canvas */
  x: number;
  /** Layer Y position on canvas */
  y: number;
  /** Vips blend mode string (from blendModeMap.ts) */
  blendMode: string;
  /** Layer opacity (0-1) */
  opacity: number;
  /** Whether this is an 8-bit source (will be upsampled to 16-bit) */
  is8bit: boolean;
  /**
   * Optional adjustments to apply in 16-bit domain before compositing.
   * Uses AdjustmentState from models.ts — same type as Layer.adjustments.
   * Applied by vips natively — full 16-bit precision, no quantization.
   */
  adjustments?: AdjustmentState;
}

/** Options for multi-layer 16-bit composite export */
export interface CompositeExportOptions {
  /** Output format */
  format: 'tiff' | 'png';
  /** TIFF compression */
  compression?: string;
  /** Output DPI */
  dpi?: number;
  /** JPEG quality (only for TIFF JPEG compression) */
  jpegQuality?: number;
  /** BigTIFF support */
  bigtiff?: boolean;
  /** Tile layout */
  tile?: boolean;
  /** Tile dimensions */
  tileWidth?: number;
  tileHeight?: number;
}

/**
 * Composites multiple layers into a 16-bit TIFF/PNG output using vips.
 *
 * This is the public API for multi-layer 16-bit export. Each layer is provided
 * as raw file bytes with position, blend mode, and opacity information.
 * Layers without 16-bit raw source are upsampled from 8-bit (value * 257).
 *
 * @param pixels - PixelService instance (provides fileIO namespace)
 * @param layers - Array of layer descriptors (bottom to top order)
 * @param canvasWidth - Output canvas width
 * @param canvasHeight - Output canvas height
 * @param options - Export options (format, compression, dpi, etc.)
 * @returns Blob containing the composited output
 */
export async function compositeMultiLayer16bit(
  pixels: PixelService,
  layers: CompositeLayerDescriptor[],
  canvasWidth: number,
  canvasHeight: number,
  options: CompositeExportOptions,
): Promise<Blob> {
  const outputBytes = await pixels.fileIO.composite16bit({
    layers: layers.map(l => ({
      bytes: l.bytes,
      x: l.x,
      y: l.y,
      blendMode: l.blendMode,
      opacity: l.opacity,
      is8bit: l.is8bit,
      adjustments: l.adjustments as Record<string, unknown> | undefined,
    })),
    canvasWidth,
    canvasHeight,
    options: {
      format: options.format,
      compression: options.compression,
      dpi: options.dpi,
      jpegQuality: options.jpegQuality,
      bigtiff: options.bigtiff,
      tile: options.tile,
      tileWidth: options.tileWidth,
      tileHeight: options.tileHeight,
    },
  });

  const mimeType = options.format === 'png' ? 'image/png' : 'image/tiff';
  return new Blob([outputBytes.buffer as ArrayBuffer], { type: mimeType });
}
