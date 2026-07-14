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
 * Upscale Worker Message Protocol
 *
 * Defines the message types exchanged between the main thread and the
 * upscale Web Worker. Uses the same reqId-based request/response pattern
 * as the BgRemoval and Segmentation workers.
 */

// ─── Main → Worker ───────────────────────────────────────────────────────────

export interface UpscaleRequest {
  reqId: number;
  action: 'upscale' | 'download';
  modelId: string;
  /** Input image RGBA buffer (Transferable — zero-copy to Worker). */
  imageData?: { data: ArrayBuffer; width: number; height: number };
  /** Target scale factor. */
  scale?: 2 | 4;
  /** Tile size in pixels (default 256). */
  tileSize?: number;
}

// ─── Worker → Main ───────────────────────────────────────────────────────────

export interface UpscaleProgress {
  type: 'progress';
  reqId: number;
  stage: 'detecting-device' | 'loading' | 'downloading' | 'processing';
  device?: 'webgpu' | 'wasm';
  /** Model download progress bytes loaded. */
  loaded?: number;
  /** Model download total bytes. */
  total?: number;
  /** Overall processing progress (0-1), valid during 'processing' stage. */
  progress?: number;
  /** Current tile being processed (1-based). */
  currentTile?: number;
  /** Total number of tiles. */
  totalTiles?: number;
}

export interface UpscaleResult {
  type: 'result';
  reqId: number;
  action: 'upscale' | 'download';
  /** Output RGBA buffer (scaled size) — Transferable. */
  imageData?: { data: ArrayBuffer; width: number; height: number };
  debug?: {
    deviceUsed: 'webgpu' | 'wasm';
    totalMs: number;
    tilesProcessed: number;
  };
}

export interface UpscaleError {
  type: 'error';
  reqId: number;
  error: string;
}

export type UpscaleResponse = UpscaleProgress | UpscaleResult | UpscaleError;
