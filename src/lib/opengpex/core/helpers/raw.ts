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
 * Camera RAW image decoding via libraw-wasm.
 *
 * libraw-wasm internally spawns its own Web Worker and loads its WASM binary,
 * so all heavy computation is off the main thread. We simply instantiate the
 * class, feed it the RAW buffer, and receive decoded RGBA pixels.
 *
 * The library resolves its worker.js and libraw.wasm via `import.meta.url`.
 * In our bundled environment we import it directly from node_modules — the
 * bundler (Turbopack/Webpack) handles the worker URL resolution.
 */

import type { RawImageData } from 'libraw-wasm';

let LibRawClass: typeof import('libraw-wasm').default | null = null;

/**
 * Dynamically imports libraw-wasm (deferred to avoid bundling cost on startup).
 */
async function getLibRawClass() {
  if (LibRawClass) return LibRawClass;
  const mod = await import('libraw-wasm');
  LibRawClass = mod.default;
  return LibRawClass;
}

/**
 * Converts a camera RAW file to a PNG Blob.
 *
 * Supports all LibRaw formats: CR2, CR3, NEF, NRW, ARW, DNG, ORF, RW2, RAF,
 * PEF, SRW, RAW, RWL, 3FR, FFF, IIQ, and more (1200+ cameras).
 *
 * @param file - The RAW camera file
 * @returns PNG Blob (sRGB, 8-bit)
 */
export async function convertRawToBlob(file: File): Promise<Blob> {
  const LibRaw = await getLibRawClass();
  const instance = new LibRaw();

  try {
    const buffer = await file.arrayBuffer();

    // Open and decode the RAW file with camera white balance and sRGB output
    await instance.open(new Uint8Array(buffer), {
      useCameraWb: true,
      outputColor: 1,   // sRGB
      outputBps: 8,     // 8-bit output
      userQual: 3,      // AHD interpolation (good quality, reasonable speed)
    });

    // Get processed image data
    const imageData: RawImageData | undefined = await instance.imageData();
    if (!imageData) {
      throw new Error('Failed to decode RAW image: no image data returned');
    }

    const { width, height, data, colors } = imageData;

    // libraw-wasm returns RGB (3 channels) or RGBA (4 channels) depending on the file
    // We need to convert to RGBA for OffscreenCanvas
    let rgbaData: Uint8ClampedArray<ArrayBuffer>;

    if (colors === 3) {
      // RGB → RGBA conversion
      rgbaData = new Uint8ClampedArray(width * height * 4);
      const src = data as Uint8Array;
      for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
        rgbaData[j] = src[i];
        rgbaData[j + 1] = src[i + 1];
        rgbaData[j + 2] = src[i + 2];
        rgbaData[j + 3] = 255;
      }
    } else {
      // Already RGBA — copy into a fresh ArrayBuffer to satisfy ImageData constructor
      rgbaData = new Uint8ClampedArray(width * height * 4);
      rgbaData.set(new Uint8Array(data.buffer, data.byteOffset, width * height * 4));
    }

    // Encode to PNG via OffscreenCanvas
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const imgData = new ImageData(rgbaData, width, height);
    ctx.putImageData(imgData, 0, 0);

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    console.log(`[RawHandler] Conversion complete: ${width}×${height}`);
    return blob;
  } catch (error) {
    console.error('[RawHandler] Conversion failed', error);
    throw error;
  } finally {
    instance.dispose();
  }
}
