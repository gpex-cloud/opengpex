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
 * Vector Rasterization — DPI Selection Dialog.
 *
 * Sole responsibility: For SVG/EPS formats, prompt the user to select a
 * rasterization DPI and compute the decode options (targetWidth/Height).
 */

'use client';

import type { EditorContextValue } from '@opengpex/editor/core/types';
import { DPI_PRESETS, getVectorIntrinsicSize } from '@opengpex/editor/core/files';

/** Decode options produced by the vector DPI dialog. */
export interface VectorDecodeOptions {
  dpi: number;
  targetWidth: number;
  targetHeight: number;
}

/**
 * Shows a DPI selection dialog for vector formats (SVG/EPS).
 *
 * @param ctx - Editor context (for dialog interaction)
 * @param file - The vector file to inspect for intrinsic dimensions
 * @param format - Detected format string ('svg' | 'eps')
 * @returns VectorDecodeOptions if user confirmed, null if cancelled or on error.
 */
export async function promptVectorDpi(
  ctx: EditorContextValue,
  file: File,
  format: string,
): Promise<VectorDecodeOptions | null> {
  const { actions } = ctx;
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
  const scale = dpi / 72;
  let targetWidth = Math.round(intrinsicSize.w * scale);
  let targetHeight = Math.round(intrinsicSize.h * scale);

  if (targetWidth > MAX_RASTER_DIMENSION || targetHeight > MAX_RASTER_DIMENSION) {
    const clampRatio = MAX_RASTER_DIMENSION / Math.max(targetWidth, targetHeight);
    targetWidth = Math.round(targetWidth * clampRatio);
    targetHeight = Math.round(targetHeight * clampRatio);
    actions.notifyHUD(`Output clamped to ${targetWidth}×${targetHeight} px (maximum ${MAX_RASTER_DIMENSION} px per side).`, 'info');
  }

  return { dpi, targetWidth, targetHeight };
}

/**
 * Returns true if the given format string represents a vector format
 * that requires DPI-based rasterization.
 */
export function isVectorFormat(format: string): boolean {
  return format === 'svg' || format === 'eps';
}
