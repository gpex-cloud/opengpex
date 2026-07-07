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
 * PNG Format Handler.
 *
 * Responsibilities:
 * - Decode: browser-native (no transcoding), parse pHYs/iCCP/tEXt/sRGB/IHDR chunks
 * - Encode: canvas.convertToBlob + chunk reassembly (pHYs DPI, iCCP, tEXt injection)
 * - Metadata: streaming chunk parser without decompressing IDAT
 *
 * Thread model: ALL operations run on main thread (<100ms for typical files).
 * PNG chunk parsing is O(n) over chunk headers only, skipping IDAT data.
 */

import ExifReader from 'exifreader';
import type { AssetService } from '@opengpex/editor/core/types';
import type {
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
} from '../types';
import { bitmapToCanvas } from '../index';
import { iccToBase64, base64ToIcc, parseIccProfileName } from '../icc';

// PNG signature bytes
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export class PngHandler implements ImageFormatHandler {
  readonly format = 'png';
  readonly mimeTypes = ['image/png'];
  readonly extensions = ['png'];

  constructor(private assets: AssetService) {}

  // ─── Decode ──────────────────────────────────────────────────────────────

  async decode(file: File, _options?: DecodeOptions): Promise<DecodeResult> {
    // PNG is browser-native — no transcoding needed
    const img = await createImageBitmap(file);
    const dimensions = { w: img.width, h: img.height };
    img.close();

    const metadata = await this.extractMetadata(file);

    // Phase 5: Preserve raw source for 16-bit fidelity export
    const rawBlob = metadata.bitDepth > 8 ? file : undefined;

    return { safeFile: file, dimensions, metadata, rawBlob };
  }

  // ─── Encode ──────────────────────────────────────────────────────────────

  async encode(
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    options: EncodeOptions,
  ): Promise<Blob> {
    const canvas = source instanceof ImageBitmap ? bitmapToCanvas(source) : source;

    // 1. Get base PNG blob from browser encoder
    const baseBlob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });

    const meta = options.metadata;
    const config = options.exportConfig;

    // If no metadata to inject, return as-is
    const dpi = config?.dpi || meta?.dpi;
    const hasAuthor = !!(config?.author?.name || meta?.author?.name);
    const hasCopyright = !!(config?.author?.copyright || meta?.author?.copyright);
    const writeSoftware = config?.writeSoftwareTag !== false;

    if (!dpi && !hasAuthor && !hasCopyright && !writeSoftware && !config?.embedIcc) {
      return baseBlob;
    }

    // 2. Reassemble PNG chunks with metadata injection
    try {
      const buffer = await baseBlob.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Verify PNG signature
      for (let i = 0; i < 8; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) return baseBlob;
      }

      const chunks: Uint8Array[] = [];

      // PNG Signature (8 bytes)
      chunks.push(bytes.slice(0, 8));

      // IHDR chunk (4 length + 4 type + 13 data + 4 CRC = 25 bytes, starting at offset 8)
      chunks.push(bytes.slice(8, 33));

      // Insert pHYs chunk (DPI)
      if (dpi && dpi > 0) {
        chunks.push(buildPhysChunk(dpi));
      }

      // Insert sRGB chunk if appropriate
      if (meta?.colorSpace === 'srgb' && !config?.embedIcc) {
        chunks.push(buildSrgbChunk());
      }

      // Insert iCCP chunk if embedding ICC Profile
      if (config?.embedIcc && meta?.raw?.iccProfileData) {
        const iccBytes = base64ToIcc(meta.raw.iccProfileData);
        chunks.push(await buildIccpChunkCompressed(iccBytes, meta.raw.iccProfileName));
      }

      // Insert tEXt chunks (Author, Copyright, Software)
      if (hasAuthor) {
        const name = config?.author?.name || meta?.author?.name || '';
        chunks.push(buildTextChunk('Author', name));
      }
      if (hasCopyright) {
        const cr = config?.author?.copyright || meta?.author?.copyright || '';
        chunks.push(buildTextChunk('Copyright', cr));
      }
      if (writeSoftware) {
        chunks.push(buildTextChunk('Software', 'OpenGPEX'));
      }

      // Insert tIME chunk (current export timestamp)
      chunks.push(buildTimeChunk());

      // Remaining original chunks (skip any we're replacing to avoid duplicates)
      let offset = 33; // After signature + IHDR
      while (offset < bytes.length) {
        const chunkLength = new DataView(buffer, offset, 4).getUint32(0, false);
        const chunkType = String.fromCharCode(
          bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7],
        );
        const totalChunkSize = 12 + chunkLength; // 4(length) + 4(type) + data + 4(CRC)

        // Skip chunks we're replacing
        if (chunkType === 'pHYs' || chunkType === 'sRGB' || chunkType === 'tEXt'
            || chunkType === 'iCCP' || chunkType === 'tIME' || chunkType === 'iTXt') {
          offset += totalChunkSize;
          continue;
        }

        chunks.push(bytes.slice(offset, offset + totalChunkSize));
        offset += totalChunkSize;
      }

      const result = concatUint8Arrays(chunks);
      return new Blob([result.buffer as ArrayBuffer], { type: 'image/png' });
    } catch (e) {
      console.warn('[PngHandler.encode] Chunk injection failed, returning raw blob:', e);
      return baseBlob;
    }
  }

  // ─── Metadata Extraction ─────────────────────────────────────────────────

  async extractMetadata(file: File): Promise<ImageMetadata> {
    const base: ImageMetadata = {
      version: 1,
      sourceFormat: 'png',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 8,
      hasAlpha: true, // PNG default assumption
      hasIccProfile: false,
    };

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Verify PNG signature
      for (let i = 0; i < 8; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) return base;
      }

      // Parse chunks
      let offset = 8;
      while (offset < bytes.length) {
        if (offset + 8 > bytes.length) break;
        const chunkLength = new DataView(buffer, offset, 4).getUint32(0, false);
        const chunkType = String.fromCharCode(
          bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7],
        );
        const dataStart = offset + 8;

        switch (chunkType) {
          case 'IHDR': {
            // IHDR: 13 bytes — width(4) + height(4) + bitDepth(1) + colorType(1) + ...
            if (chunkLength >= 13) {
              base.bitDepth = bytes[dataStart + 8];
              const colorType = bytes[dataStart + 9];
              base.hasAlpha = (colorType === 4 || colorType === 6);
              if (colorType === 0 || colorType === 4) base.colorSpace = 'grayscale';
            }
            break;
          }

          case 'pHYs': {
            // pHYs: 9 bytes — ppmX(4) + ppmY(4) + unit(1)
            if (chunkLength >= 9) {
              const ppmX = new DataView(buffer, dataStart, 4).getUint32(0, false);
              const unit = bytes[dataStart + 8];
              if (unit === 1 && ppmX > 0) {
                // Unit = meter → convert to DPI
                const dpi = Math.round(ppmX * 0.0254);
                if (dpi > 1 && dpi < 10000) {
                  base.dpi = dpi;
                  base.dpiSource = 'png-phys';
                }
              }
            }
            break;
          }

          case 'iCCP': {
            base.hasIccProfile = true;
            base.colorSpace = 'unknown'; // Has custom profile, not necessarily sRGB

            // Extract ICC Profile: name\0 + compression_method(1) + compressed_data
            if (chunkLength > 2) {
              const chunkData = bytes.slice(dataStart, dataStart + chunkLength);
              const nameEnd = chunkData.indexOf(0);
              if (nameEnd > 0) {
                const profileName = new TextDecoder().decode(chunkData.slice(0, nameEnd));
                const compressionMethod = chunkData[nameEnd + 1];
                const compressedIcc = chunkData.slice(nameEnd + 2);

                if (compressionMethod === 0 && compressedIcc.length > 0) {
                  try {
                    const decompressed = await decompressZlib(compressedIcc);
                    base.raw = base.raw || {};
                    base.raw.iccProfileData = iccToBase64(decompressed);
                    base.raw.iccProfileName = parseIccProfileName(decompressed) || profileName;

                    // Detect known color spaces from ICC profile name
                    const pName = (base.raw.iccProfileName || '').toLowerCase();
                    if (pName.includes('adobe') && pName.includes('rgb')) {
                      base.colorSpace = 'adobe-rgb';
                    } else if (pName.includes('display p3') || pName.includes('p3')) {
                      base.colorSpace = 'display-p3';
                    } else if (pName.includes('prophoto')) {
                      base.colorSpace = 'prophoto-rgb';
                    } else if (pName.includes('srgb')) {
                      base.colorSpace = 'srgb';
                    }
                  } catch {
                    // Decompression failed — profile name only
                    base.raw = base.raw || {};
                    base.raw.iccProfileName = profileName;
                  }
                }
              }
            }
            break;
          }

          case 'sRGB': {
            base.colorSpace = 'srgb';
            base.hasIccProfile = false; // sRGB chunk and iCCP are mutually exclusive
            break;
          }

          case 'tEXt': {
            // tEXt: key\0value
            if (chunkLength > 0) {
              const data = bytes.slice(dataStart, dataStart + chunkLength);
              const nullIdx = data.indexOf(0);
              if (nullIdx > 0) {
                const key = new TextDecoder().decode(data.slice(0, nullIdx));
                const value = new TextDecoder().decode(data.slice(nullIdx + 1));
                if (!base.author) base.author = {};
                if (key === 'Author') base.author.name = value;
                else if (key === 'Copyright') base.author.copyright = value;
                else if (key === 'Description') base.author.description = value;
              }
            }
            break;
          }

          case 'gAMA': {
            // gAMA: 4 bytes (gamma × 100000)
            if (chunkLength === 4) {
              const gammaInt = new DataView(buffer, dataStart, 4).getUint32(0, false);
              const gamma = gammaInt / 100000;
              if (gamma >= 0.1 && gamma <= 10.0) {
                base.raw = base.raw || {};
                base.raw.gamma = gamma;
              }
            }
            break;
          }

          case 'tIME': {
            // tIME: 7 bytes — year(2) + month(1) + day(1) + hour(1) + minute(1) + second(1)
            if (chunkLength === 7) {
              const year = new DataView(buffer, dataStart, 2).getUint16(0, false);
              const month = bytes[dataStart + 2];
              const day = bytes[dataStart + 3];
              const hour = bytes[dataStart + 4];
              const minute = bytes[dataStart + 5];
              const second = bytes[dataStart + 6];
              const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
              if (!isNaN(date.getTime())) {
                base.dates = base.dates || {};
                base.dates.modified = date.toISOString();
              }
            }
            break;
          }

          case 'iTXt': {
            // iTXt: key\0 + compressionFlag(1) + compressionMethod(1) + lang\0 + transKey\0 + text
            if (chunkLength > 5) {
              const data = bytes.slice(dataStart, dataStart + chunkLength);
              const keyEnd = data.indexOf(0);
              if (keyEnd > 0) {
                const key = new TextDecoder().decode(data.slice(0, keyEnd));
                const compressionFlag = data[keyEnd + 1];
                const compressionMethod = data[keyEnd + 2];

                // Skip language tag and translated keyword (both null-terminated)
                let pos = keyEnd + 3;
                const langEnd = data.indexOf(0, pos);
                if (langEnd >= pos) {
                  pos = langEnd + 1;
                  const transKeyEnd = data.indexOf(0, pos);
                  if (transKeyEnd >= pos) {
                    pos = transKeyEnd + 1;

                    // Rest is text content (may be compressed)
                    const rawTextBytes = data.slice(pos);
                    try {
                      const finalBytes = (compressionFlag === 1 && compressionMethod === 0 && rawTextBytes.length > 0)
                        ? await decompressZlib(rawTextBytes)
                        : rawTextBytes;
                      const value = new TextDecoder('utf-8').decode(finalBytes);
                      if (!base.author) base.author = {};
                      if (key === 'Author') base.author.name = value;
                      else if (key === 'Copyright') base.author.copyright = value;
                      else if (key === 'Comment' || key === 'Description') base.author.description = value;
                    } catch { /* iTXt decompression failed — skip */ }
                  }
                }
              }
            }
            break;
          }

          case 'eXIf': {
            // eXIf: raw EXIF bytes (TIFF IFD structure, same as JPEG APP1 without "Exif\0\0")
            if (chunkLength > 8) {
              const exifData = new Uint8Array(chunkLength);
              exifData.set(bytes.subarray(dataStart, dataStart + chunkLength));
              try {
                // Store raw bytes for export round-trip
                base.raw = base.raw || {};
                base.raw.exifBytes = iccToBase64(exifData); // reuse base64 helper

                // Parse with ExifReader for structured metadata
                const exifBuffer = new ArrayBuffer(exifData.byteLength);
                new Uint8Array(exifBuffer).set(exifData);
                const tags = ExifReader.load(exifBuffer, { expanded: true });

                // Camera info
                const make = tags.exif?.Make?.description;
                const model = tags.exif?.Model?.description;
                if (make || model) {
                  base.camera = {
                    make, model,
                    lensMake: tags.exif?.LensMake?.description,
                    lensModel: tags.exif?.LensModel?.description,
                    software: tags.exif?.Software?.description,
                  };
                }

                // Capture parameters
                const fNum = tags.exif?.FNumber?.value;
                const expTime = tags.exif?.ExposureTime?.value;
                const iso = tags.exif?.ISOSpeedRatings?.value;
                if (fNum || expTime || iso) {
                  base.capture = {
                    fNumber: fNum ? (Array.isArray(fNum) ? fNum[0] / (fNum[1] || 1) : Number(fNum)) : undefined,
                    exposureTime: expTime ? (Array.isArray(expTime) ? expTime[0] / (expTime[1] || 1) : Number(expTime)) : undefined,
                    iso: iso ? (Array.isArray(iso) ? Number(iso[0]) : Number(iso)) : undefined,
                    focalLength: tags.exif?.FocalLength?.value
                      ? (Array.isArray(tags.exif.FocalLength.value)
                          ? tags.exif.FocalLength.value[0] / (tags.exif.FocalLength.value[1] || 1)
                          : Number(tags.exif.FocalLength.value))
                      : undefined,
                  };
                }

                // Dates from EXIF
                const dateStr = tags.exif?.DateTimeOriginal?.description;
                if (dateStr) {
                  const normalized = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
                  const d = new Date(normalized);
                  if (!isNaN(d.getTime())) {
                    base.dates = base.dates || {};
                    base.dates.created = d.toISOString();
                  }
                }

                // GPS
                const lat = tags.gps?.Latitude;
                const lon = tags.gps?.Longitude;
                if (lat != null && lon != null) {
                  base.gps = { latitude: Number(lat), longitude: Number(lon) };
                }
              } catch { /* eXIf parsing failed — non-critical */ }
            }
            break;
          }

          case 'IEND': {
            // Stop parsing at IEND
            offset = bytes.length;
            continue;
          }
        }

        offset += 12 + chunkLength; // 4(length) + 4(type) + data + 4(CRC)
      }
    } catch (err) {
      console.debug('[PngHandler] Chunk parsing failed:', (err as Error).message);
    }

    return base;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PNG Chunk Builders
// ═══════════════════════════════════════════════════════════════════════════════

/** CRC32 lookup table (PNG standard polynomial 0xEDB88320) */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

/** Compute CRC32 over a Uint8Array */
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Build a complete PNG chunk: 4(length) + 4(type) + data + 4(CRC) */
function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);

  // Length
  view.setUint32(0, data.length, false);
  // Type
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  // Data
  chunk.set(data, 8);
  // CRC (over type + data)
  const crcData = chunk.slice(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcData), false);

  return chunk;
}

/** Build pHYs chunk for DPI injection */
function buildPhysChunk(dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254); // DPI → pixels per meter
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, ppm, false); // X pixels per unit
  view.setUint32(4, ppm, false); // Y pixels per unit
  data[8] = 1; // Unit = meter
  return buildChunk('pHYs', data);
}

/** Build sRGB chunk (rendering intent = Perceptual) */
function buildSrgbChunk(): Uint8Array {
  return buildChunk('sRGB', new Uint8Array([0])); // 0 = Perceptual
}

/**
 * Build iCCP chunk with deflate-compressed ICC Profile (PNG spec compliant).
 * Uses browser-native CompressionStream for zlib deflate.
 */
async function buildIccpChunkCompressed(
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

/** Build tIME chunk (last modification timestamp) */
function buildTimeChunk(date?: Date): Uint8Array {
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

/** Build tEXt chunk (key\0value) */
function buildTextChunk(key: string, value: string): Uint8Array {
  const keyBytes = new TextEncoder().encode(key);
  const valueBytes = new TextEncoder().encode(value);
  const data = new Uint8Array(keyBytes.length + 1 + valueBytes.length);
  data.set(keyBytes, 0);
  data[keyBytes.length] = 0; // null separator
  data.set(valueBytes, keyBytes.length + 1);
  return buildChunk('tEXt', data);
}

/** Concatenate multiple Uint8Arrays */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Zlib Compress/Decompress (browser-native Streams API)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Decompress zlib/deflate data using browser-native DecompressionStream.
 * Used for reading iCCP chunk compressed ICC Profile data.
 * Supported: Chrome 80+, Safari 16.4+, Firefox 113+
 */
async function decompressZlib(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(compressed as unknown as BufferSource);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatUint8Arrays(chunks);
}

/**
 * Compress data with zlib/deflate using browser-native CompressionStream.
 * Used for writing iCCP chunk with properly compressed ICC Profile data.
 * Supported: Chrome 80+, Safari 16.4+, Firefox 113+
 */
async function compressZlib(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(data as unknown as BufferSource);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatUint8Arrays(chunks);
}
