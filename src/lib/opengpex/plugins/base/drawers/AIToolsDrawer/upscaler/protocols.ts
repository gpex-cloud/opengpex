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
 * Upscaler Feature Protocols
 *
 * Domain-level types, constants and configuration for the AI upscaler feature.
 * These are consumed by the panel, commands, hooks, and settings UI.
 *
 * Worker wire-level types live in `./worker.types.ts`.
 */

// ─── Command IDs ─────────────────────────────────────────────────────────────

export const CMD_UPSCALE = 'cmd.upscale';
export const CMD_UPSCALE_DOWNLOAD = 'cmd.upscale_download';
export const CMD_UPSCALE_ABORT = 'cmd.upscale_abort';

// ─── Signal IDs ──────────────────────────────────────────────────────────────

export const SIGNAL_UPSCALE_STATUS = 'signal.upscale_status';

// ─── Status Types ────────────────────────────────────────────────────────────

export type UpscaleStage =
  | 'idle'
  | 'downloading'
  | 'processing'
  | 'done'
  | 'error';

export interface UpscaleStatus {
  [key: string]: unknown;
  stage: UpscaleStage;
  device: 'webgpu' | 'wasm' | null;
  downloadProgress: number;
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number;
  processingProgress: number;
  currentTile: number;
  totalTiles: number;
  errorMessage: string | null;
  elapsedMs: number;
}

export const INITIAL_UPSCALE_STATUS: UpscaleStatus = {
  stage: 'idle',
  device: null,
  downloadProgress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  speedBps: 0,
  etaSeconds: 0,
  processingProgress: 0,
  currentTile: 0,
  totalTiles: 0,
  errorMessage: null,
  elapsedMs: 0,
};

// ─── Model Management ────────────────────────────────────────────────────────

export interface UpscaleModelEntry {
  id: string;
  name: string;
  modelId: string;
  /**
   * ONNX filename within the HuggingFace repo.
   * Most upscaler repos do NOT use "model.onnx" — each has its own naming.
   * Examples: "4x-UltraSharpV2_fp32_op17.onnx", "realesrgan-x4plus-anime.onnx"
   * Falls back to "model.onnx" if not specified.
   */
  onnxFile?: string;
  size: string;
  scale: number;
  description: string;
  builtin: boolean;
  default?: boolean;
}

export const BUILTIN_UPSCALE_MODELS: UpscaleModelEntry[] = [
  {
    id: '4x-ultrasharp-v2',
    name: '4× UltraSharp V2',
    modelId: 'Kim2091/UltraSharpV2',
    onnxFile: '4x-UltraSharpV2_fp32_op17.onnx',
    size: '~52 MB',
    scale: 4,
    description: 'Gold standard — best quality for photos & general use',
    builtin: true,
    default: true,
  },
  {
    id: '4x-clearreality-v1',
    name: '4× ClearReality V1',
    modelId: 'Kim2091/ClearRealityV1',
    onnxFile: 'ONNX/fp32/4x-ClearRealityV1-fp32-opset17.onnx',
    size: '~1.7 MB',
    scale: 4,
    description: 'Ultra-compact — instant download, great for quick previews',
    builtin: true,
  },
  {
    id: 'RealESRGAN_x4plus_anime_6B',
    name: '4× Real-ESRGAN Anime',
    modelId: 'deepghs/imgutils-models',
    onnxFile: 'real_esrgan/RealESRGAN_x4plus_anime_6B.onnx',
    size: '~18 MB',
    scale: 4,
    description: 'Optimized for anime, illustrations & flat-color art',
    builtin: true,
  },
  {
    id: '2x-AnimeSharpV4',
    name: '2× AnimeSharp V4',
    modelId: 'Kim2091/2x-AnimeSharpV4',
    onnxFile: '2x-AnimeSharpV4_RCAN_fp16_op17.onnx',
    size: '~31 MB',
    scale: 2,
    description: 'High-detail 2× upscale for anime & illustration',
    builtin: true,
  },
];

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * DPI mode determines how upscaling affects print dimensions:
 * - 'increase-resolution': Pixels grow Nx, DPI unchanged → larger physical print (default)
 * - 'increase-dpi': Pixels grow Nx, DPI scales Nx → same physical print size, higher sharpness
 */
export type UpscaleDpiMode = 'increase-resolution' | 'increase-dpi';

export interface UpscaleConfig {
  [key: string]: unknown;
  models: UpscaleModelEntry[];
  activeModelId: string;
  tileSize: number;
  /** Output mode: 'new-frame' creates a new frame, 'replace' replaces current frame via frame.resize.replace */
  outputMode: 'new-frame' | 'replace';
  targetScale: 2 | 4;
  /** DPI behaviour after upscale. Default: 'increase-resolution' (keep DPI, enlarge print). */
  dpiMode: UpscaleDpiMode;
}

export const DEFAULT_UPSCALE_CONFIG: UpscaleConfig = {
  models: [...BUILTIN_UPSCALE_MODELS],
  activeModelId: BUILTIN_UPSCALE_MODELS[0].id,
  tileSize: 256,
  outputMode: 'new-frame',
  targetScale: 4,
  dpiMode: 'increase-resolution',
};

// ─── Model Files (download manifest) ─────────────────────────────────────────

/**
 * Default ONNX filename used when `UpscaleModelEntry.onnxFile` is not specified.
 * Most real-world repos use custom filenames, so this is merely a fallback.
 */
export const DEFAULT_UPSCALE_ONNX_FILE = 'model.onnx';

/**
 * Build the download file list for a given upscaler model.
 * Upscaler repos are pure-ONNX (no config.json / preprocessor_config.json needed).
 */
export function getUpscaleModelFiles(model: UpscaleModelEntry): { filename: string }[] {
  return [{ filename: model.onnxFile ?? DEFAULT_UPSCALE_ONNX_FILE }];
}
