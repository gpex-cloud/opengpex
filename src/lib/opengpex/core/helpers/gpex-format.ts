/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * gpex-format: Binary pack/unpack for the .gpex file format (v1).
 *
 * .gpex is a container format that bundles:
 *   - A WebP thumbnail (for previews)
 *   - A JSON manifest (metadata: frame info, dimensions, etc.)
 *   - A ZIP payload (state.json + assets/ blobs)
 *
 * Binary Layout:
 * ┌────────────────────────────────────────────────────┐
 * │  Header (20 bytes, Little-Endian)                   │
 * │  [0..3]   magic         "GPEX" (4B ASCII)          │
 * │  [4..5]   version       uint16 LE (=1)             │
 * │  [6..7]   headerSize    uint16 LE (=20)            │
 * │  [8..11]  thumbnailSize uint32 LE                  │
 * │  [12..15] manifestSize  uint32 LE                  │
 * │  [16..19] payloadSize   uint32 LE                  │
 * ├────────────────────────────────────────────────────┤
 * │  Body                                               │
 * │  [thumbnail bytes] [manifest JSON] [payload ZIP]    │
 * └────────────────────────────────────────────────────┘
 *
 * This format is independent of cloud storage — it can be used
 * for local export/import, drag-and-drop, or any file I/O scenario.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Manifest embedded in every .gpex file.
 * Server uses `frameLocalId` as the UPSERT key.
 */
export interface GpexManifest {
  format: "gpex";
  version: number;
  frameLocalId: string;
  frameName: string;
  canvasWidth: number;
  canvasHeight: number;
  layerCount: number;
  assetCount: number;
  editorVersion: string;
}

/**
 * Structured data extracted from a .gpex binary file.
 */
export interface GpexFileData {
  /** Thumbnail image (WebP) */
  thumbnail: Blob;
  /** Parsed manifest JSON */
  manifest: GpexManifest;
  /** ZIP archive containing state.json + assets/ */
  payload: ArrayBuffer;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAGIC = [0x47, 0x50, 0x45, 0x58]; // "GPEX"
const FORMAT_VERSION = 1;
const HEADER_SIZE = 20;

// ─── Pack ───────────────────────────────────────────────────────────────────

/**
 * Pack editor data into a .gpex binary file.
 *
 * @param thumbnail - WebP image bytes (can be empty Uint8Array if no thumbnail)
 * @param manifest  - Manifest object (will be JSON-serialized)
 * @param payload   - ZIP archive bytes (state.json + assets/)
 * @returns Complete .gpex file as ArrayBuffer
 */
export function packGpex(
  thumbnail: Uint8Array,
  manifest: GpexManifest,
  payload: Uint8Array,
): ArrayBuffer {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  const totalSize = HEADER_SIZE + thumbnail.byteLength + manifestBytes.byteLength + payload.byteLength;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // ─── Header ─────────────────────────────────────────
  bytes.set(MAGIC, 0);                                     // [0..3]  magic
  view.setUint16(4, FORMAT_VERSION, true);                 // [4..5]  version
  view.setUint16(6, HEADER_SIZE, true);                    // [6..7]  headerSize
  view.setUint32(8, thumbnail.byteLength, true);           // [8..11] thumbnailSize
  view.setUint32(12, manifestBytes.byteLength, true);      // [12..15] manifestSize
  view.setUint32(16, payload.byteLength, true);            // [16..19] payloadSize

  // ─── Body ──────────────────────────────────────────
  let offset = HEADER_SIZE;
  bytes.set(thumbnail, offset);
  offset += thumbnail.byteLength;

  bytes.set(manifestBytes, offset);
  offset += manifestBytes.byteLength;

  bytes.set(payload, offset);

  return buffer;
}

// ─── Unpack ─────────────────────────────────────────────────────────────────

/**
 * Unpack a .gpex binary file into structured data.
 *
 * @param buffer - Complete .gpex file content
 * @returns Parsed { thumbnail, manifest, payload }
 * @throws Error if the file is not a valid .gpex format
 */
export function unpackGpex(buffer: ArrayBuffer): GpexFileData {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error('Not a valid .gpex file: too small');
  }

  const view = new DataView(buffer);
  const magicBytes = new Uint8Array(buffer, 0, 4);
  const magic = String.fromCharCode(...magicBytes);

  if (magic !== 'GPEX') {
    throw new Error('Not a valid .gpex file: invalid magic bytes');
  }

  // const version = view.getUint16(4, true);  // reserved for future version handling
  const headerSize = view.getUint16(6, true);
  const thumbnailSize = view.getUint32(8, true);
  const manifestSize = view.getUint32(12, true);
  const payloadSize = view.getUint32(16, true);

  // Validate sizes
  const expectedSize = headerSize + thumbnailSize + manifestSize + payloadSize;
  if (buffer.byteLength < expectedSize) {
    throw new Error(`Not a valid .gpex file: expected ${expectedSize} bytes, got ${buffer.byteLength}`);
  }

  // ─── Extract segments ──────────────────────────────
  let offset = headerSize;

  const thumbnailBytes = buffer.slice(offset, offset + thumbnailSize);
  offset += thumbnailSize;

  const manifestBytes = buffer.slice(offset, offset + manifestSize);
  offset += manifestSize;

  const payloadBytes = buffer.slice(offset, offset + payloadSize);

  // ─── Parse ─────────────────────────────────────────
  const manifestJson = new TextDecoder().decode(manifestBytes);
  const manifest: GpexManifest = JSON.parse(manifestJson);

  return {
    thumbnail: new Blob([thumbnailBytes], { type: 'image/webp' }),
    manifest,
    payload: payloadBytes,
  };
}
