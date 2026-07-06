/**
 * OpenGPEX - SVG Rasterizer Worker (resvg-wasm)
 *
 * Dedicated Worker for SVG → PNG rasterization using resvg-wasm (Rust resvg compiled to WASM).
 * Lazily loaded by VectorHandler when SVG files are imported.
 *
 * Protocol: { id, fn, args } → { id, out } | { id, error }
 *
 * Functions:
 * - transcodeSvg(svgText: string, params: { width?, height?, maxDimension? }) → Uint8Array (PNG)
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

let resvgModule = null;

async function ensureResvgReady() {
  if (resvgModule) return;

  // Dynamic import of the resvg ESM module (served from same directory)
  resvgModule = await import('/ext/wasm/resvg/index.js');

  // Fetch and initialize the WASM binary
  const wasmResponse = await fetch('/ext/wasm/resvg/resvg.wasm');
  const wasmBytes = await wasmResponse.arrayBuffer();
  await resvgModule.initWasm(wasmBytes);

  console.log('[ResvgWorker] resvg-wasm initialized');
}

/**
 * Transcode SVG text → PNG bytes using resvg-wasm.
 */
async function transcodeSvg(svgText, params) {
  await ensureResvgReady();

  let fitTo;
  if (params?.width) {
    fitTo = { mode: 'width', value: params.width };
  } else if (params?.height) {
    fitTo = { mode: 'height', value: params.height };
  } else {
    fitTo = { mode: 'width', value: params?.maxDimension || 4096 };
  }

  const resvg = new resvgModule.Resvg(svgText, { fitTo });
  const rendered = resvg.render();
  const pngData = rendered.asPng();

  return new Uint8Array(pngData.buffer || pngData);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Message Handler
// ═══════════════════════════════════════════════════════════════════════════════

const handlers = { transcodeSvg };

self.onmessage = async ({ data: msg }) => {
  const { id, fn, args } = msg;

  if (!handlers[fn]) {
    self.postMessage({ id, error: `Unknown function: ${fn}` });
    return;
  }

  try {
    const result = await handlers[fn](...(args || []));
    const transfer = result?.buffer ? [result.buffer] : [];
    self.postMessage({ id, out: result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
