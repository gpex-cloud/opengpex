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

let avifWasmInited = false;
let encodeAvif: ((data: ImageData, options: Record<string, unknown>) => Promise<ArrayBuffer>) | null = null;

self.onmessage = async (e) => {
 const { action, payload } = e.data;

 if (action === 'ENCODE_AVIF') {
 const { bitmap, quality = 0.92 } = payload;
 try {
 if (!avifWasmInited) {
 // dynamically import the wrapper which we just copied
 const { default: encode, init: initAvifEncode } = await import('./avif-lib-wrapper');
 await initAvifEncode({
 locateFile: (path: string) =>`/ext/wasm/${path}`
 });
 encodeAvif = encode;
 avifWasmInited = true;
 }

 // Draw ImageBitmap to OffscreenCanvas to extract pixels
 const { width, height } = bitmap;
 const canvas = new OffscreenCanvas(width, height);
 const ctx = canvas.getContext('2d');
 if (!ctx) throw new Error('Cannot get 2d context for AVIF encoding');
 
 ctx.drawImage(bitmap, 0, 0);
 const imageData = ctx.getImageData(0, 0, width, height);
 bitmap.close(); // free memory

 // Encode
 if (!encodeAvif) throw new Error('AVIF encoder not initialized');
 const avifBuffer = await encodeAvif(imageData, { quality: Math.round(quality * 100) });
 const avifBlob = new Blob([avifBuffer], { type: 'image/avif' });

 self.postMessage({
 success: true,
 blob: avifBlob
 });
 } catch (error: unknown) {
 self.postMessage({ success: false, error: (error as Error).message });
 }
 }
};

const emptyModule = {};
export default emptyModule;
