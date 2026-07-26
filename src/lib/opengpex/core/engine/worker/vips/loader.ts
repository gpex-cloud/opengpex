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
 * loader.ts — wasm-vips singleton manager for engine Worker.
 *
 * Design notes (architecture doc §五 & phase5 §6):
 * - vips WASM is loaded lazily on first use (does NOT block app startup)
 * - Once loaded, the instance is kept alive for the Worker's lifetime
 * - Only one vips instance per Worker — shared by VipsBackend + FILE_IO handler
 * - vips-worker.js (Emscripten pthread sub-Worker) stays at /ext/wasm/vips/
 *
 * Thread model:
 * - This module runs exclusively inside the engine Worker thread
 * - importScripts() loads the vips.js Emscripten glue into the Worker global scope
 * - The Emscripten module spawns pthread sub-Workers internally (vips-worker.js)
 */

import type { VipsInstance } from './types';

let vipsInstance: VipsInstance | null = null;
let loadingPromise: Promise<VipsInstance> | null = null;

/**
 * Vips factory function shape exposed on the Worker global scope
 * after importScripts('/ext/wasm/vips/vips.js').
 */
interface VipsFactory {
  (opts: {
    mainScriptUrlOrBlob: string;
    locateFile: (filename: string) => string;
    dynamicLibraries: string[];
    print: (msg: string) => void;
    printErr: (msg: string) => void;
  }): Promise<VipsInstance>;
}

/**
 * Worker global scope augmented with the Vips factory after importScripts.
 */
interface VipsWorkerGlobal {
  Vips: VipsFactory;
  importScripts: (...urls: string[]) => void;
}

/**
 * Get the vips singleton instance. Lazily initializes on first call.
 *
 * Safe to call multiple times concurrently — the loading promise is deduped.
 * After successful load, returns the cached instance immediately.
 *
 * @throws Error if vips WASM fails to load (network error, OOM, etc.)
 */
export async function getVips(): Promise<VipsInstance> {
  if (vipsInstance) return vipsInstance;

  // Deduplicate concurrent loads
  if (!loadingPromise) {
    loadingPromise = initializeVips();
  }

  vipsInstance = await loadingPromise;
  return vipsInstance;
}

/**
 * Internal: load and initialize wasm-vips.
 * Called at most once per Worker lifetime.
 */
async function initializeVips(): Promise<VipsInstance> {
  const workerGlobal = self as unknown as VipsWorkerGlobal;

  // Load the Emscripten glue script into Worker global scope
  workerGlobal.importScripts('/ext/wasm/vips/vips.js');

  if (!workerGlobal.Vips) {
    throw new Error(
      '[vips/loader] Failed to load wasm-vips: Vips factory not found on global scope. ' +
      'Ensure /ext/wasm/vips/vips.js is accessible.',
    );
  }

  const instance = await workerGlobal.Vips({
    mainScriptUrlOrBlob: '/ext/wasm/vips/vips.js',
    locateFile: (filename: string) => `/ext/wasm/vips/${filename}`,
    dynamicLibraries: [],
    print: () => {},    // Suppress stdout
    printErr: () => {}, // Suppress stderr
  });

  return instance;
}
