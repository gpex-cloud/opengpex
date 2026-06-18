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
 * handlers/transcoder.ts: SVG transcoding handler using resvg-wasm
 * Converts SVG files to PNG raster in the Worker thread (non-blocking).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

let resvgInitialized = false;
let ResvgModule: any = null;

async function ensureResvgReady() {
  if (resvgInitialized) return;

  // Dynamic import of resvg-wasm (the JS glue code is bundled, wasm is fetched at runtime)
  ResvgModule = await import('@resvg/resvg-wasm');

  const wasmUrl = '/ext/wasm/resvg.wasm';
  const wasmResponse = await fetch(wasmUrl);
  const wasmBytes = await wasmResponse.arrayBuffer();
  await ResvgModule.initWasm(wasmBytes);

  resvgInitialized = true;
}

/**
 * Transcodes an SVG Blob to a PNG raster Blob using resvg-wasm.
 * Runs entirely in the Worker thread — does not require DOM access.
 *
 * @param blob - The SVG file as a Blob (type: image/svg+xml)
 * @param maxDimension - Maximum output width (default 4096px, prevents excessive memory usage)
 * @returns PNG Blob
 */
export async function transcodeSvgToRaster(blob: Blob, maxDimension = 4096): Promise<Blob> {
  await ensureResvgReady();

  const svgText = await blob.text();

  const resvg = new ResvgModule.Resvg(svgText, {
    fitTo: { mode: 'width', value: maxDimension }
  });

  const rendered = resvg.render();
  const pngData = rendered.asPng();

  return new Blob([pngData.buffer], { type: 'image/png' });
}
