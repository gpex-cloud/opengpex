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
export async function readImageDimensions(
  file: Blob,
  options?: { imageOrientation?: ImageOrientation },
): Promise<{ w: number; h: number }> {
  const img = await createImageBitmap(file, options);
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

// ═══════════════════════════════════════════════════════════════════════════════
// Gamut sniff — paste-time identity inference from bare PNG bytes
// ═══════════════════════════════════════════════════════════════════════════════

import { iterateChunks, verifySignature } from './handlers/png/chunks';
import { readiCCP } from './handlers/png/readers';
import { inferColorSpaceFromIcc, parseIccProfileName } from './shared/icc';
import { toGamutId } from '../types';
import type { GamutId } from '../types';

/**
 * sniffPngGamut — Best-effort gamut inference from a bare PNG byte stream.
 *
 * External pastes arrive as an opaque image blob with no ingest metadata, so
 * the embedded ICC profile (iCCP chunk) is the only identity signal available.
 * The sniff reuses the same parsing and name-inference stack the file ingest
 * uses (PNG chunk iteration → zlib-decoded iCCP → profile-name → color space)
 * so a pasted file is tagged exactly as the same file would be on import.
 *
 * Deliberately conservative: only `display-p3` is ever returned as a
 * non-default tag. The 8-bit resident texture lane decodes with the standard
 * sRGB EOTF, which is correct for sRGB and Display-P3 (both sRGB-curve) but
 * WRONG for Adobe RGB / ProPhoto / Rec.2020 (pure-gamma curves) — tagging
 * those here would promise an identity the render lane cannot honor and
 * misdecode every sample. Wide-gamut 8-bit sources therefore keep the
 * untagged default (an honest limitation of the external paste lane, and in
 * practice a non-case: browsers flatten clipboard PNGs to sRGB/P3 anyway).
 *
 * Returns `undefined` when the bytes are not a decodable PNG, carry no iCCP
 * chunk, or name a profile that must not be tagged on the 8-bit lane. Never
 * throws: a sniff is metadata enrichment, and any failure means "keep the
 * default".
 */
export async function sniffPngGamut(bytes: Uint8Array): Promise<GamutId | undefined> {
  try {
    if (!verifySignature(bytes)) return undefined;

    for (const chunk of iterateChunks(bytes)) {
      if (chunk.type !== 'iCCP') continue;
      const iccp = await readiCCP(chunk.data);
      if (!iccp) return undefined;

      // The iCCP chunk's own name field is a free-form copy label; the profile
      // description embedded in the ICC bytes is the authority, so prefer it.
      const profileName = parseIccProfileName(iccp.iccBytes) ?? iccp.profileName;
      const colorSpace = inferColorSpaceFromIcc(profileName);
      if (colorSpace === 'unknown') return undefined;

      // Only a gamut the 8-bit sRGB-EOTF lane decodes correctly may be tagged;
      // wide gamuts fall through to the untagged default (see module comment).
      const gamut = toGamutId(colorSpace);
      return gamut === 'display-p3' ? gamut : undefined;
    }
  } catch {
    return undefined; // malformed stream — metadata enrichment must not throw
  }
  return undefined;
}
