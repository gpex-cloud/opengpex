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
 * Denoise Feature Protocols
 *
 * Domain-level types, constants and configuration for the AI denoise feature
 * (NAFNet image restoration network).
 *
 * Runtime state is managed by `./store.ts` (module-level store).
 * Worker wire-level types live in `./worker.types.ts`.
 */

// ─── Tool Identity ───────────────────────────────────────────────────────────

/** Config sub-key used for persisted plugin config (e.g. `config.denoiser`). */
export const MODEL_TYPE_KEY = 'denoiser' as const;
/** Human-readable display name for this tool category. */
export const MODEL_TYPE_NAME = 'Denoiser';

// ─── Command IDs ─────────────────────────────────────────────────────────────

export const CMD_DENOISE = 'cmd.denoiser';
export const CMD_DENOISE_ABORT = 'cmd.denoiser_abort';

import type { ModelEntry, ModelCatalog } from '../_shared/types';

// ─── Model Management ────────────────────────────────────────────────────────

/**
 * Denoise model entry — extends ModelEntry with the restoration pipeline kind.
 *
 * `pipeline` reserves dispatch capability for the worker: today every entry is
 * a plain 'single' model (one ONNX, one inference pass). When the planned
 * old-photo-restore chain (denoise → colorize → face restore) lands, the
 * worker will route on this field instead of growing a parallel tool.
 */
export interface NafNetModelEntry extends ModelEntry {
  /** Restoration pipeline this entry participates in. Default: 'single'. */
  pipeline?: 'single' | 'old-photo-restore';
}

// Byte counts HEAD-probed 2026-11-23 via the ModelScope mirror of the same
// repo (`Content-Length` on
// modelscope.cn/api/v1/models/deepghs/image_restoration/repo). huggingface.co
// itself was unreachable from the build environment; the mirror serves the
// identical repo files. Same-source download URLs stay on the modelId below.
export const BUILTIN_DENOISE_MODELS: NafNetModelEntry[] = [
  {
    id: 'nafnet-reds-width64',
    name: 'NAFNet Denoise',
    modelId: 'deepghs/image_restoration',
    onnxFile: 'NAFNet-REDS-width64_v1.onnx',
    expectedBytes: 275_396_149, // HEAD-probed 2026-11-23
    size: '~263 MB',
    description: 'NAFNet image denoiser (REDS-trained) — removes sensor/ISO noise, keeps resolution',
    pipeline: 'single',
    builtin: true,
  },
  {
    id: 'scunet-psnr',
    name: 'SCUNet Denoise (Light)',
    modelId: 'deepghs/image_restoration',
    onnxFile: 'SCUNet-PSNR.onnx',
    expectedBytes: 91_264_256, // HEAD-probed 2026-11-23
    size: '~87 MB',
    description: 'SCUNet denoiser — much smaller download, slightly softer result; pick this on slow connections',
    pipeline: 'single',
    builtin: true,
  },
];

// ─── Configuration ───────────────────────────────────────────────────────────

export interface DenoiseConfig extends ModelCatalog {
  models: NafNetModelEntry[];
  /** Tile size in pixels for inference (NAFNet needs tiling on large images). */
  tileSize: number;
  /**
   * Output mode:
   *   'new-layer' → full-size patch layer directly above the source
   *                 (non-destructive; denoise is resolution-preserving);
   *   'new-frame' → new trunk frame from the denoised image (canvas = the
   *                 image dimensions, same ingest path as the upscaler).
   */
  outputMode: 'new-layer' | 'new-frame';
}

export const DEFAULT_DENOISE_CONFIG: DenoiseConfig = {
  models: [...BUILTIN_DENOISE_MODELS],
  activeModelId: BUILTIN_DENOISE_MODELS[0].id,
  tileSize: 256, // NAFNet is heavy per-pixel — 256px tiles balance VRAM vs blending overhead
  outputMode: 'new-layer',
};
