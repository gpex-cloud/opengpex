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
 * BgRemover Feature Protocols
 *
 * Domain-level types, constants and configuration for the AI background removal
 * feature. These are consumed by the panel, commands, hooks, and settings UI.
 *
 * Runtime state is managed by `./store.ts` (module-level store).
 * Worker wire-level types live in `./worker.types.ts`.
 */

// ─── Tool Identity ───────────────────────────────────────────────────────────

/** Config sub-key used for persisted plugin config (e.g. `config.bgremover`). */
export const MODEL_TYPE_KEY = 'bgremover' as const;
/** Human-readable display name for this tool category. */
export const MODEL_TYPE_NAME = 'BG Remover';

// ─── Command IDs ─────────────────────────────────────────────────────────────

export const CMD_REMOVE_BG = 'cmd.remove_bg';
export const CMD_ABORT = 'cmd.abort';
export const CMD_OPEN_SETTINGS = 'cmd.open_settings';

import type { ModelEntry, ModelCatalog } from '../_shared/types';

export type { ModelEntry, ModelCatalog } from '../_shared/types';

/**
 * @deprecated Use `ModelCatalog` from `'../_shared/types'` directly.
 */
export type BgRemoverConfig = ModelCatalog;

// ─── Model Management ────────────────────────────────────────────────────────

// ─── Built-in Models ─────────────────────────────────────────────────────────

export const BUILTIN_MODELS: ModelEntry[] = [
  {
    id: 'OS-Software/InSPyReNet-SwinB-Plus-Ultra-ONNX',
    name: 'InSPyReNet Ultra',
    modelId: 'OS-Software/InSPyReNet-SwinB-Plus-Ultra-ONNX',
    onnxFile: 'onnx/model_fp16.onnx',
    expectedBytes: 210_000_000, // ~200 MB
    size: '~200 MB',
    description: 'Sharp edges, excellent for products & e-commerce',
    builtin: true,
  },
  {
    id: 'briaai/RMBG-1.4',
    name: 'RMBG 1.4',
    modelId: 'briaai/RMBG-1.4',
    onnxFile: 'onnx/model_fp16.onnx',
    expectedBytes: 95_000_000, // ~90 MB
    size: '~90 MB',
    description: 'Fast, general-purpose background removal',
    builtin: true,
  },
];

export const DEFAULT_BG_REMOVAL_CONFIG: ModelCatalog = {
  models: [...BUILTIN_MODELS],
  activeModelId: BUILTIN_MODELS[0].id,
};

