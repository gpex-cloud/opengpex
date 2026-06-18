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

/* eslint-disable @next/next/no-assign-module-variable */

import { defaultOptions } from '@jsquash/avif/meta.js';
import { initEmscriptenModule } from '@jsquash/avif/utils.js';

interface AvifModule {
 encode(data: Uint8Array, width: number, height: number, options: Record<string, unknown>): { buffer: ArrayBuffer } | null;
}

let emscriptenModule: Promise<AvifModule> | undefined;

export async function init(module?: WebAssembly.Module | Record<string, unknown>, moduleOptionOverrides?: Record<string, unknown>) {
 let actualModule: WebAssembly.Module | undefined = module instanceof WebAssembly.Module ? module : undefined;
 let actualOptions: Record<string, unknown> | undefined = moduleOptionOverrides;
 // If only one argument is provided and it's not a WebAssembly.Module
 if (arguments.length === 1 && !(module instanceof WebAssembly.Module)) {
 actualModule = undefined;
 actualOptions = module as Record<string, unknown>;
 }
 
 // FORCIBLY load only the non-mt version to avoid Next.js nested worker circular dependencies
 const avifEncoder = await import('@jsquash/avif/codec/enc/avif_enc.js');
 emscriptenModule = initEmscriptenModule(avifEncoder.default, actualModule, actualOptions);
 return emscriptenModule;
}

export default async function encode(data: ImageData, options: Record<string, unknown> = {}) {
 if (!emscriptenModule) {
 emscriptenModule = init();
 }
 const _options = { ...defaultOptions, ...options };
 if (_options.bitDepth !== 8 &&
 _options.bitDepth !== 10 &&
 _options.bitDepth !== 12) {
 throw new Error('Invalid bit depth. Supported values are 8, 10, or 12.');
 }
 if (!(data.data instanceof Uint16Array) && _options.bitDepth !== 8) {
 throw new Error('Invalid image data for bit depth. Must use Uint16Array for bit depths greater than 8.');
 }
 if (_options.lossless) {
 if (options.quality !== undefined && options.quality !== 100) {
 console.warn('AVIF lossless: Quality setting is ignored when lossless is enabled (quality must be 100).');
 }
 if (options.qualityAlpha !== undefined &&
 options.qualityAlpha !== 100 &&
 options.qualityAlpha !== -1) {
 console.warn('AVIF lossless: QualityAlpha setting is ignored when lossless is enabled (qualityAlpha must be 100 or -1).');
 }
 if (options.subsample !== undefined && options.subsample !== 3) {
 console.warn('AVIF lossless: Subsample setting is ignored when lossless is enabled (subsample must be 3 for YUV444).');
 }
 _options.quality = 100;
 _options.qualityAlpha = -1;
 _options.subsample = 3;
 }
 const module = await emscriptenModule;
 const output = module.encode(new Uint8Array(data.data.buffer), data.width, data.height, _options);
 if (!output) {
 throw new Error('Encoding error.');
 }
 return output.buffer;
}
