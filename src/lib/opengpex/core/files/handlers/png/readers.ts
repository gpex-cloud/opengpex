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
 * PNG chunk type readers.
 *
 * Each function reads a specific chunk type's payload and returns
 * a structured result. All functions are pure (no side effects).
 */

import { decompressZlib } from './zlib';

// ═══════════════════════════════════════════════════════════════════════════════
// IHDR
// ═══════════════════════════════════════════════════════════════════════════════

export interface IHDRInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  hasAlpha: boolean;
  isGrayscale: boolean;
}

/** Read IHDR chunk (13 bytes): width(4) + height(4) + bitDepth(1) + colorType(1) + ... */
export function readIHDR(data: Uint8Array): IHDRInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(0, false);
  const height = view.getUint32(4, false);
  const bitDepth = data[8];
  const colorType = data[9];
  const hasAlpha = (colorType === 4 || colorType === 6);
  const isGrayscale = (colorType === 0 || colorType === 4);
  return { width, height, bitDepth, colorType, hasAlpha, isGrayscale };
}

// ═══════════════════════════════════════════════════════════════════════════════
// pHYs
// ═══════════════════════════════════════════════════════════════════════════════

export interface PhysInfo {
  dpi: number;
}

/** Read pHYs chunk (9 bytes): ppmX(4) + ppmY(4) + unit(1) */
export function readpHYs(data: Uint8Array): PhysInfo | null {
  if (data.length < 9) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ppmX = view.getUint32(0, false);
  const unit = data[8];
  if (unit !== 1 || ppmX <= 0) return null; // unit must be meter
  const dpi = Math.round(ppmX * 0.0254);
  if (dpi < 2 || dpi >= 10000) return null;
  return { dpi };
}

// ═══════════════════════════════════════════════════════════════════════════════
// iCCP
// ═══════════════════════════════════════════════════════════════════════════════

export interface IccpInfo {
  profileName: string;
  iccBytes: Uint8Array;
}

/** Read iCCP chunk: name\0 + compression_method(1) + compressed_data */
export async function readiCCP(data: Uint8Array): Promise<IccpInfo | null> {
  if (data.length < 3) return null;
  const nameEnd = data.indexOf(0);
  if (nameEnd <= 0) return null;

  const profileName = new TextDecoder().decode(data.subarray(0, nameEnd));
  const compressionMethod = data[nameEnd + 1];
  const compressedIcc = data.subarray(nameEnd + 2);

  if (compressionMethod !== 0 || compressedIcc.length === 0) return null;

  try {
    const iccBytes = await decompressZlib(compressedIcc);
    return { profileName, iccBytes };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// eXIf
// ═══════════════════════════════════════════════════════════════════════════════

/** Read eXIf chunk: returns raw EXIF bytes (TIFF IFD structure) */
export function readeXIf(data: Uint8Array): Uint8Array {
  // eXIf chunk payload IS the raw EXIF bytes — no wrapper to strip
  return new Uint8Array(data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// tEXt
// ═══════════════════════════════════════════════════════════════════════════════

export interface TextEntry {
  key: string;
  value: string;
}

/** Read tEXt chunk: key\0value (Latin-1 encoding) */
export function readtEXt(data: Uint8Array): TextEntry {
  const nullIdx = data.indexOf(0);
  if (nullIdx <= 0) return { key: '', value: '' };
  const key = new TextDecoder().decode(data.subarray(0, nullIdx));
  const value = new TextDecoder().decode(data.subarray(nullIdx + 1));
  return { key, value };
}

// ═══════════════════════════════════════════════════════════════════════════════
// iTXt
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read iTXt chunk: key\0 + compressionFlag(1) + compressionMethod(1)
 *                  + lang\0 + transKey\0 + text
 */
export async function readiTXt(data: Uint8Array): Promise<TextEntry | null> {
  if (data.length < 6) return null;
  const keyEnd = data.indexOf(0);
  if (keyEnd <= 0) return null;

  const key = new TextDecoder().decode(data.subarray(0, keyEnd));
  const compressionFlag = data[keyEnd + 1];
  const compressionMethod = data[keyEnd + 2];

  // Skip language tag and translated keyword (both null-terminated)
  let pos = keyEnd + 3;
  const langEnd = data.indexOf(0, pos);
  if (langEnd < pos) return null;
  pos = langEnd + 1;
  const transKeyEnd = data.indexOf(0, pos);
  if (transKeyEnd < pos) return null;
  pos = transKeyEnd + 1;

  // Rest is text content (may be compressed)
  const rawTextBytes = data.subarray(pos);
  try {
    const finalBytes = (compressionFlag === 1 && compressionMethod === 0 && rawTextBytes.length > 0)
      ? await decompressZlib(rawTextBytes)
      : rawTextBytes;
    const value = new TextDecoder('utf-8').decode(finalBytes);
    return { key, value };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// tIME
// ═══════════════════════════════════════════════════════════════════════════════

/** Read tIME chunk (7 bytes): year(2) + month(1) + day(1) + hour(1) + minute(1) + second(1) */
export function readtIME(data: Uint8Array): string | null {
  if (data.length < 7) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const year = view.getUint16(0, false);
  const month = data[2];
  const day = data[3];
  const hour = data[4];
  const minute = data[5];
  const second = data[6];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (isNaN(date.getTime())) return null;
  return date.toISOString();
}

// ═══════════════════════════════════════════════════════════════════════════════
// gAMA
// ═══════════════════════════════════════════════════════════════════════════════

/** Read gAMA chunk (4 bytes): gamma × 100000 */
export function readgAMA(data: Uint8Array): number | null {
  if (data.length < 4) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const gammaInt = view.getUint32(0, false);
  const gamma = gammaInt / 100000;
  if (gamma < 0.1 || gamma > 10.0) return null;
  return gamma;
}
