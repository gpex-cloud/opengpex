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

export interface RasterizeParams {
  width?: number;
  height?: number;
  maxDimension?: number;  // fallback if width/height not specified
}

/**
 * Transcodes an SVG Blob to a PNG raster Blob using resvg-wasm.
 * Runs entirely in the Worker thread — does not require DOM access.
 *
 * @param blob - The SVG file as a Blob (type: image/svg+xml)
 * @param params - Rasterization parameters (width, height, or maxDimension fallback)
 * @returns PNG Blob
 */
export async function transcodeSvgToRaster(blob: Blob, params?: RasterizeParams): Promise<Blob> {
  await ensureResvgReady();

  const svgText = await blob.text();

  let fitTo: { mode: string; value: number };
  if (params?.width) {
    fitTo = { mode: 'width', value: params.width };
  } else if (params?.height) {
    fitTo = { mode: 'height', value: params.height };
  } else {
    fitTo = { mode: 'width', value: params?.maxDimension || 4096 };
  }

  const resvg = new ResvgModule.Resvg(svgText, { fitTo });

  const rendered = resvg.render();
  const pngData = rendered.asPng();

  return new Blob([pngData.buffer], { type: 'image/png' });
}

/**
 * EPS Transcoding via Ghostscript WASM (@okathira/ghostpdl-wasm)
 *
 * Uses the Emscripten-compiled GhostPDL module which provides:
 * - `callMain(args)`: Executes Ghostscript with CLI arguments
 * - `FS`: Emscripten virtual filesystem for input/output
 *
 * The module factory is loaded once (lazy) from /ext/wasm/gs.js and
 * instantiated with `locateFile` pointing to /ext/wasm/gs.wasm.
 */

let gsInstance: any = null;

async function ensureGsReady() {
  if (gsInstance) return;

  // Dynamic import from served static path (bypasses bundler)
  // @ts-expect-error — runtime-only path, not a TS module
  const { default: GsModuleFactory } = await import(/* webpackIgnore: true */ '/ext/wasm/gs.js');

  // Instantiate the Emscripten module, pointing locateFile to our served WASM
  gsInstance = await GsModuleFactory({
    locateFile: (path: string) => `/ext/wasm/${path}`,
    // Suppress Emscripten stdout/stderr logging in Worker
    print: () => {},
    printErr: () => {},
  });
}

export interface EpsRasterizeParams {
  width: number;
  height: number;
  dpi: number;
}

/**
 * Transcodes an EPS Blob to a PNG raster Blob using Ghostscript WASM.
 * Runs entirely in the Worker thread — does not require DOM access.
 *
 * @param blob - The EPS file as a Blob (type: application/postscript)
 * @param params - Rasterization parameters (width, height, dpi)
 * @returns PNG Blob
 */
export async function transcodeEpsToRaster(blob: Blob, params: EpsRasterizeParams): Promise<Blob> {
  await ensureGsReady();

  const epsData = new Uint8Array(await blob.arrayBuffer());

  // Write EPS to Ghostscript virtual filesystem
  gsInstance.FS.writeFile('/input.eps', epsData);

  // Ghostscript command-line arguments: EPS → PNG with alpha
  const args = [
    '-sDEVICE=pngalpha',
    `-r${params.dpi}`,
    `-g${params.width}x${params.height}`,
    '-dEPSCrop',
    '-dBATCH',
    '-dNOPAUSE',
    '-dQUIET',
    '-sOutputFile=/output.png',
    '-f', '/input.eps'
  ];

  // Execute Ghostscript
  gsInstance.callMain(args);

  // Read output PNG from virtual filesystem
  const pngData: Uint8Array = gsInstance.FS.readFile('/output.png');

  // Clean up virtual filesystem
  try {
    gsInstance.FS.unlink('/input.eps');
    gsInstance.FS.unlink('/output.png');
  } catch { /* ignore cleanup errors */ }

  return new Blob([new Uint8Array(pngData)], { type: 'image/png' });
}

