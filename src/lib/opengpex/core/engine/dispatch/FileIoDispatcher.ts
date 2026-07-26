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
 * FileIoDispatcher — Main-thread dispatcher for FILE_IO jobs.
 *
 * Provides typed async methods that send FILE_IO jobs to the engine Worker
 * via WorkerBridge. This replaces the self-managed VipsWorker in tiff.ts.
 *
 * Architecture (phase7_2_vips_unification.md §3 Step 4):
 * - All vips operations flow through the unified engine Worker
 * - vips WASM only loads once (shared singleton in Worker)
 * - FileService → PixelFacade.fileIO → FileIoDispatcher → bridge → Worker
 */

import type { WorkerBridge } from './bridge/WorkerBridge';
import type { FileIoJob } from '../protocol/jobs';

export class FileIoDispatcher {
  constructor(private bridge: WorkerBridge) {}

  /**
   * Decode TIFF bytes → RGBA pixel data (8-bit output).
   */
  async decodeTiff(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
    return this.bridge.request<{ width: number; height: number; data: Uint8Array }>(
      { type: 'FILE_IO', fn: 'decodeTiff', bytes },
    );
  }

  /**
   * Encode RGBA pixel data → TIFF bytes.
   */
  async encodeTiff(
    rgbaData: Uint8Array,
    width: number,
    height: number,
    options: Record<string, unknown>,
  ): Promise<Uint8Array> {
    return this.bridge.request<Uint8Array>(
      { type: 'FILE_IO', fn: 'encodeTiff', rgbaData, width, height, options },
    );
  }

  /**
   * Get page count and per-page dimensions of a multi-page TIFF.
   */
  async getPageCount(bytes: Uint8Array): Promise<{ pages: number; pageWidth: number; pageHeight: number }> {
    return this.bridge.request<{ pages: number; pageWidth: number; pageHeight: number }>(
      { type: 'FILE_IO', fn: 'getPageCount', bytes },
    );
  }

  /**
   * Decode a specific page of a multi-page TIFF to RGBA pixel data.
   */
  async decodePage(bytes: Uint8Array, page: number): Promise<{ width: number; height: number; data: Uint8Array }> {
    return this.bridge.request<{ width: number; height: number; data: Uint8Array }>(
      { type: 'FILE_IO', fn: 'decodePage', bytes, page },
    );
  }

  /**
   * Multi-layer 16-bit composite export via vips.
   */
  async composite16bit(params: {
    layers: FileIoJob['layers'];
    canvasWidth: number;
    canvasHeight: number;
    options: Record<string, unknown>;
  }): Promise<Uint8Array> {
    return this.bridge.request<Uint8Array>({
      type: 'FILE_IO',
      fn: 'composite16bit',
      layers: params.layers,
      canvasWidth: params.canvasWidth,
      canvasHeight: params.canvasHeight,
      options: params.options,
    });
  }

  /**
   * High-resolution 16-bit export from raw source bytes.
   */
  async exportHighRes(rawBytes: Uint8Array, options: Record<string, unknown>): Promise<Uint8Array> {
    return this.bridge.request<Uint8Array>(
      { type: 'FILE_IO', fn: 'exportHighRes', bytes: rawBytes, options },
    );
  }
}
