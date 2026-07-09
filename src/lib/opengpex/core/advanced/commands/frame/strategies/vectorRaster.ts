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
 * Vector Rasterization Strategy.
 *
 * Handles the SVG/EPS DPI selection dialog and unified file decode.
 * For vector formats: prompts user for rasterization DPI before decoding.
 * For raster formats: decodes directly.
 *
 * Returns the decoded result along with metadata needed by subsequent
 * import strategies, or null if user cancelled.
 */

'use client';

import type { EditorContextValue } from '@opengpex/editor/core/types';
import type { DecodeResult } from '@opengpex/editor/core/files/types';
import { DPI_PRESETS, getVectorIntrinsicSize } from '@opengpex/editor/core/files';

/** Result of the decode-with-vector-dialog flow */
export interface DecodeWithDialogResult {
  decoded: DecodeResult;
  file: File;
  sourceType: 'local' | 'url';
  chosenFrameDpi?: number;
}

/**
 * Resolves file source and performs decode with optional vector DPI dialog.
 *
 * For SVG/EPS: presents a DPI selection dialog, then decodes at chosen resolution.
 * For raster formats: decodes directly without dialog.
 *
 * @returns DecodeWithDialogResult if successful, null if user cancelled.
 */
export async function decodeWithVectorDialog(
  ctx: EditorContextValue,
  source: File | string,
): Promise<DecodeWithDialogResult | null> {
  const { actions, pixels, files } = ctx;

  // 1. Resolve source to File
  let file: File;
  let sourceType: 'local' | 'url' = 'local';

  if (typeof source === 'string') {
    sourceType = 'url';
    file = await actions.withSignal(
      'sys.asset.downloading',
      () => pixels.utils.fetchFromUrl(source),
    );
  } else {
    file = source;
  }

  // 2. Format detection
  const format = files.detectFormat(file);
  let chosenFrameDpi: number | undefined;
  let decodeOptions: { dpi?: number; targetWidth?: number; targetHeight?: number } | undefined;

  // 3. Vector DPI dialog (SVG/EPS only)
  if (format === 'svg' || format === 'eps') {
    const formatLabel = format.toUpperCase();
    const DEFAULT_DPI = 300;
    const MAX_RASTER_DIMENSION = 16384;

    let intrinsicSize: { w: number; h: number };
    try {
      intrinsicSize = await getVectorIntrinsicSize(file);
    } catch (err) {
      console.error(`[FrameCreate] Failed to parse ${formatLabel} intrinsic size:`, err);
      actions.notifyHUD(`Failed to parse ${formatLabel} file dimensions. The file may be corrupted.`, 'error');
      return null;
    }

    const allOptions = DPI_PRESETS.map(p => ({
      id: String(p.value),
      label: `${p.value} DPI`,
      description: `${p.label} · ${Math.round(intrinsicSize.w * p.value / 72)}×${Math.round(intrinsicSize.h * p.value / 72)} px`,
      primary: p.value === DEFAULT_DPI,
    }));
    const vectorHelpText = `OpenGPEX is a raster (pixel) image editor and does not support native vector editing for ${formatLabel} files. The file will be rasterized at the selected resolution for pixel-level editing.`;
    const chosenDpi = await actions.askChoice(`${formatLabel} Rasterize Resolution`, allOptions, vectorHelpText);
    if (!chosenDpi) return null; // User cancelled

    const dpi = parseInt(chosenDpi, 10) || DEFAULT_DPI;
    chosenFrameDpi = dpi;
    const scale = dpi / 72;
    let targetWidth = Math.round(intrinsicSize.w * scale);
    let targetHeight = Math.round(intrinsicSize.h * scale);

    if (targetWidth > MAX_RASTER_DIMENSION || targetHeight > MAX_RASTER_DIMENSION) {
      const clampRatio = MAX_RASTER_DIMENSION / Math.max(targetWidth, targetHeight);
      targetWidth = Math.round(targetWidth * clampRatio);
      targetHeight = Math.round(targetHeight * clampRatio);
      actions.notifyHUD(`Output clamped to ${targetWidth}×${targetHeight} px (maximum ${MAX_RASTER_DIMENSION} px per side).`, 'info');
    }

    decodeOptions = { targetWidth, targetHeight, dpi };
  }

  // 4. Unified decode
  let decoded: DecodeResult;
  try {
    decoded = await actions.withSignal(
      files.needsTranscoding(file) ? 'sys.asset.transcoding' : '',
      () => files.decode(file, decodeOptions),
    );
  } catch (err) {
    console.error(`[FrameCreate] File decode failed:`, err);
    actions.notifyHUD(`Failed to process file. The format may not be supported.`, 'error');
    return null;
  }

  return { decoded, file, sourceType, chosenFrameDpi };
}
