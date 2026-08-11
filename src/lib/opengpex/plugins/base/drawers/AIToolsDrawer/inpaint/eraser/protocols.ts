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
 * Inpaint Eraser Feature Protocols
 *
 * Domain-level types, constants and configuration for the AI Smart Eraser feature.
 * These are consumed by the panel, commands, hooks, and settings UI.
 *
 * Worker wire-level types live in `./worker.types.ts`.
 * Runtime state is managed by `./store.ts` (no signal-based status types here).
 */

// ─── Command IDs ─────────────────────────────────────────────────────────────

export const CMD_INPAINT_ERASER = 'cmd.inpaint_eraser';
export const CMD_INPAINT_ERASER_ABORT = 'cmd.inpaint_eraser_abort';

import type { ModelEntry, ModelCatalog } from '../../_shared/types';

// ─── Model Management ────────────────────────────────────────────────────────

/**
 * Inpaint Eraser model entry — extends ModelEntry with input resolution.
 */
export interface InpaintEraserModelEntry extends ModelEntry {
  /** Model's native input resolution (width/height). Most inpainting models expect square inputs. */
  inputSize: number;
}

export const BUILTIN_ERASER_MODELS: InpaintEraserModelEntry[] = [
  {
    id: 'lama-fp32',
    name: 'LaMa FP32',
    modelId: 'Carve/LaMa-ONNX',
    onnxFile: 'lama_fp32.onnx',
    size: '~200 MB',
    description: 'Full-precision — maximum quality. Fixed 512×512 input.',
    builtin: true,
    inputSize: 512,
    device: 'wasm', // LaMa uses DFT ops not supported by WebGPU EP
  },
];

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Output mode determines how the inpainting result is applied:
 * - 'new-layer': Creates a new patch layer above the source (default, non-destructive)
 * - 'replace': Flattens the patch into the source layer (destructive)
 */
export type InpaintOutputMode = 'new-layer' | 'replace';

export interface InpaintEraserConfig extends ModelCatalog {
  models: InpaintEraserModelEntry[];
  outputMode: InpaintOutputMode;
}

export const DEFAULT_INPAINT_ERASER_CONFIG: InpaintEraserConfig = {
  models: [...BUILTIN_ERASER_MODELS],
  activeModelId: BUILTIN_ERASER_MODELS[0].id,
  outputMode: 'new-layer',
};

