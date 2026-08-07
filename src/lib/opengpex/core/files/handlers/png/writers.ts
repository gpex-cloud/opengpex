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
 * PNG chunk builders (writers).
 *
 * Each function constructs a complete PNG chunk (length + type + data + CRC)
 * ready for insertion into a PNG byte stream.
 */

import { buildChunk } from './chunks';
import { compressZlib } from './zlib';

/** Build pHYs chunk for DPI injection */
export function buildPhysChunk(dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254); // DPI → pixels per meter
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, ppm, false); // X pixels per unit
  view.setUint32(4, ppm, false); // Y pixels per unit
  data[8] = 1; // Unit = meter
  return buildChunk('pHYs', data);
}

/** Build sRGB chunk (rendering intent = Perceptual) */
export function buildSrgbChunk(): Uint8Array {
  return buildChunk('sRGB', new Uint8Array([0])); // 0 = Perceptual
}

/**
 * Build iCCP chunk with deflate-compressed ICC Profile (PNG spec compliant).
 * Uses browser-native CompressionStream for zlib deflate.
 */
export async function buildIccpChunk(
  iccBytes: Uint8Array,
  profileName?: string,
): Promise<Uint8Array> {
  const name = new TextEncoder().encode(profileName || 'ICC Profile');
  const compressed = await compressZlib(iccBytes);

  // iCCP: name\0 + compression_method(0) + compressed_data
  const data = new Uint8Array(name.length + 1 + 1 + compressed.length);
  data.set(name, 0);
  data[name.length] = 0;     // null terminator
  data[name.length + 1] = 0; // compression method (0 = deflate)
  data.set(compressed, name.length + 2);

  return buildChunk('iCCP', data);
}

/** Build tEXt chunk (key\0value) */
export function buildTextChunk(key: string, value: string): Uint8Array {
  const keyBytes = new TextEncoder().encode(key);
  const valueBytes = new TextEncoder().encode(value);
  const data = new Uint8Array(keyBytes.length + 1 + valueBytes.length);
  data.set(keyBytes, 0);
  data[keyBytes.length] = 0; // null separator
  data.set(valueBytes, keyBytes.length + 1);
  return buildChunk('tEXt', data);
}

/** Build tIME chunk (last modification timestamp) */
export function buildTimeChunk(date?: Date): Uint8Array {
  const d = date || new Date();
  const data = new Uint8Array(7);
  const view = new DataView(data.buffer);
  view.setUint16(0, d.getUTCFullYear(), false);
  data[2] = d.getUTCMonth() + 1;
  data[3] = d.getUTCDate();
  data[4] = d.getUTCHours();
  data[5] = d.getUTCMinutes();
  data[6] = d.getUTCSeconds();
  return buildChunk('tIME', data);
}

/** Build eXIf chunk from raw EXIF bytes */
export function buildExifChunk(exifBytes: Uint8Array): Uint8Array {
  return buildChunk('eXIf', exifBytes);
}
