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
 * JPEG handler utility functions — base64/blob conversions.
 */

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
 * Convert raw RGBA pixel data to a PNG Blob via OffscreenCanvas.
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
