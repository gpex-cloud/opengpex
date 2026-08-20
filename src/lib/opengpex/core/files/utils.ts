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
 * Shared utilities for file format handlers.
 *
 * Consolidates common operations (rgbaToBlob, etc.) that were previously
 * duplicated across multiple handler files (jpeg.ts, gif.ts).
 */

import type { ImageMetadata } from './types';

/**
 * Convert raw RGBA pixel data to a PNG Blob via OffscreenCanvas.
 *
 * Used by handlers that decode to raw pixels (JPEG ICC conversion, GIF frames, etc.)
 * and need to produce a displayable Blob for the editor.
 */
export async function rgbaToBlob(rgba: Uint8Array, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  const clamped = new Uint8ClampedArray(rgba.length);
  clamped.set(rgba);
  const imageData = new ImageData(clamped, width, height);
  ctx.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Metadata Display Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine if an ImageMetadata has "displayable" content worth showing
 * in the metadata panel — beyond basic dimensions (which are always shown
 * in the canvas/layer cards).
 *
 * This function centralizes the "should we show metadata panel?" logic,
 * making it reusable across FrameInfoPanel, StorageInfoPanel, etc.
 *
 * Note: AI generation info from frame.extra is handled separately by
 * AiGenerationPanel and is NOT part of this function's concern.
 *
 * @param meta - Image metadata from frame.metadata
 * @returns true if metadata panel should be shown
 *
 * @future Will be migrated to `core/files/metadata/` directory.
 */
export function hasDisplayableMetadata(meta?: ImageMetadata): boolean {
  if (!meta) return false;

  // Photographic metadata (EXIF camera/capture/dates)
  if (meta.camera || meta.capture || meta.dates) return true;
  // ICC Profile
  if (meta.raw?.icc) return true;
  // Non-trivial color space (not sRGB, not unknown)
  if (meta.colorSpace && meta.colorSpace !== 'srgb' && meta.colorSpace !== 'unknown') return true;
  // High bit depth (>8)
  if ((meta.bitDepth ?? 8) > 8) return true;
  // ComfyUI / SD WebUI workflow data in PNG tEXt
  if (isComfyUiWorkflow(meta) !== undefined) return true;
  // XMP data present (may contain AI provenance or other interesting info)
  if (meta.raw?.xmp) return true;

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI Provenance Detection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect if an ImageMetadata contains a ComfyUI workflow definition.
 * Returns the workflow JSON string if found, undefined otherwise.
 *
 * ComfyUI stores its entire workflow graph as a JSON object in PNG tEXt
 * chunk with key "prompt". The structure is:
 * - Top-level object with numeric string keys (node IDs: "6", "8", "13", etc.)
 * - Each node has: { inputs: {...}, class_type: "NodeClassName", _meta?: {...} }
 *
 * @param meta - ImageMetadata to check
 * @returns The workflow JSON string if valid ComfyUI workflow, undefined otherwise
 */
export function isComfyUiWorkflow(meta?: ImageMetadata | null): string | undefined {
  const jsonStr = meta?.raw?.pngText?.prompt;
  if (!jsonStr) return undefined;
  try {
    const obj = JSON.parse(jsonStr);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
    const keys = Object.keys(obj);
    if (keys.length === 0) return undefined;
    // ComfyUI workflow nodes have class_type and inputs fields
    const isComfy = keys.some(k => {
      const node = obj[k];
      return node && typeof node === 'object' && 'class_type' in node && 'inputs' in node;
    });
    return isComfy ? jsonStr : undefined;
  } catch {
    return undefined;
  }
}
