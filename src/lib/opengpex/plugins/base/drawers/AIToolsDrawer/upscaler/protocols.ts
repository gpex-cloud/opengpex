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
 * Runtime state is managed by `./store.ts` (module-level store).
 * Worker wire-level types live in `./worker.types.ts`.
 */

// ─── Tool Identity ───────────────────────────────────────────────────────────

/** Config sub-key used for persisted plugin config (e.g. `config.upscaler`). */
export const MODEL_TYPE_KEY = 'upscaler' as const;
/** Human-readable display name for this tool category. */
export const MODEL_TYPE_NAME = 'Upscaler';

// ─── Command IDs ─────────────────────────────────────────────────────────────

export const CMD_UPSCALE = 'cmd.upscaler';
export const CMD_UPSCALE_ABORT = 'cmd.upscaler_abort';

import type { ModelEntry, ModelCatalog } from '../_shared/types';

// ─── Model Management ────────────────────────────────────────────────────────

/**
 * Upscaler model entry — extends ModelEntry with scale factor.
 */
export interface UpscaleModelEntry extends ModelEntry {
  /** Native output scale factor of the model (2 or 4). */
  scale: number;
}

export const BUILTIN_UPSCALE_MODELS: UpscaleModelEntry[] = [
  {
    id: '2x-AnimeSharpV4-fast',
    name: '2x AnimeSharp V4 Fast',
    modelId: 'Kim2091/2x-AnimeSharpV4',
    onnxFile: '2x-AnimeSharpV4_Fast_RCAN_PU_fp16_opset17.onnx',
    size: '~30 MB',
    scale: 2,
    description: 'Fast 2x anime upscale — PixelUnshuffle variant, smaller & faster',
    builtin: true,
  },
  {
    id: 'real-esrgan-x4',
    name: '4x Real-ESRGAN General',
    modelId: 'SceneWorks/real-esrgan-onnx',
    onnxFile: 'real_esrgan_x4.onnx',
    size: '~65 MB',
    scale: 4,
    description: 'Real-ESRGAN x4 — general purpose photo & illustration upscaler',
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

export interface UpscaleConfig extends ModelCatalog {
  models: UpscaleModelEntry[];
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
  tileSize: 128,  // 128×4=512px output tile — optimal for WebGPU stability
  outputMode: 'new-frame',
  targetScale: 4,
  dpiMode: 'increase-resolution',
};

