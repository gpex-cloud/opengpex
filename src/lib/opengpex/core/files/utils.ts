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

import type { ImageMetadata, DecodeResult } from './types';

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

/**
 * Convert a Blob to a data-URL base64 string (e.g. "data:image/jpeg;base64,...").
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Convert a data-URL base64 string to a Blob.
 */
export function base64ToBlob(base64: string, type: string): Blob {
  const parts = base64.split(';base64,');
  const raw = atob(parts[1] || parts[0]);
  const uInt8Array = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    uInt8Array[i] = raw.charCodeAt(i);
  }
  return new Blob([uInt8Array], { type });
}

/**
 * Parse EXIF date string (e.g. "2024:01:15 10:30:00") to ISO 8601 string.
 * Returns undefined if the input is not a valid date.
 */
export function parseDateToISO(rawDate: unknown): string | undefined {
  if (!rawDate) return undefined;
  if (typeof rawDate === 'object' && rawDate !== null && 'getTime' in rawDate) {
    const time = (rawDate as Date).getTime();
    if (!isNaN(time)) return new Date(time).toISOString();
  }
  if (typeof rawDate === 'string') {
    const normalized = rawDate.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
    const d = new Date(normalized);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

/**
 * Decode a browser-native image just far enough to read its pixel dimensions,
 * releasing the bitmap immediately.
 *
 * For verbatim / conversion=none display branches whose `displayBlob` is the
 * original file — the bitmap itself is not needed, only its size. `close()` runs
 * in `finally` so the bitmap is freed even if dimension access ever throws.
 */
export async function readImageDimensions(file: Blob): Promise<{ w: number; h: number }> {
  const img = await createImageBitmap(file);
  try {
    return { w: img.width, h: img.height };
  } finally {
    img.close();
  }
}

/**
 * Read back the SOURCE-ENCODED 8-bit RGBA of an image with the browser's colour
 * management turned OFF (`colorSpaceConversion: 'none'`), plus its dimensions.
 *
 * This is the shared front half of every "matrix / wide-gamut-8" decode branch:
 * the raw pixels are handed to a CPU colour pipeline (source-gamut fold, correct
 * TRC, no implicit browser conversion). The bitmap is drawn to an sRGB
 * OffscreenCanvas purely as a readback surface and released before returning.
 */
export async function readSourceEncodedRgba(
  file: Blob,
): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const img = await createImageBitmap(file, { colorSpaceConversion: 'none' });
  const w = img.width;
  const h = img.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  img.close();
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

// ═══════════════════════════════════════════════════════════════════════════════
// File Acquisition
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve a `File | URL` source to a `File`. Strings are fetched; a `File` is
 * returned as-is. No pixel operations — this is pure "where do the bytes come
 * from", the files domain's concern (not `pixels.utils`, its former home).
 */
export async function toFile(source: File | string): Promise<File> {
  if (typeof source === 'string') return fromUrl(source);
  return source;
}

/** Fetch a URL and wrap the response body as a `File`. */
export async function fromUrl(url: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Network response was not ok');
  const blob = await response.blob();
  const filename = url.split('/').pop() || 'downloaded-image';
  return new File([blob], filename, { type: blob.type });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Page Semantics
// ═══════════════════════════════════════════════════════════════════════════════

/** Semantic classification of a `DecodeResult`'s pages. */
export type DecodeKind = 'single' | 'animated' | 'multipage';

/**
 * Classify a decode result's pages: `pages.length > 1` with the first page
 * carrying a `delay` is an animated sequence (GIF/APNG), otherwise a static
 * multi-page document (TIFF); a single page is `'single'`.
 */
export function classifyDecode(decoded: DecodeResult): DecodeKind {
  if (decoded.pages.length <= 1) return 'single';
  return decoded.pages[0].delay != null ? 'animated' : 'multipage';
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
