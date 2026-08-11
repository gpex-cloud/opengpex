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
 * ModelEntry — Base interface for all AI tool model entries.
 *
 * Shared by bgremover, upscaler, inpaint/eraser (and future tools).
 * Each tool extends this with tool-specific fields (e.g. `scale`, `inputSize`).
 *
 * The download layer only needs `modelId` + `onnxFile` + `expectedBytes`
 * from this interface — everything else is for UI display or inference config.
 */
export interface ModelEntry {
  /** Unique identifier (usually same as modelId for built-ins) */
  id: string;
  /** Display name shown in the UI */
  name: string;
  /** HuggingFace model repository ID (e.g. "briaai/RMBG-1.4") */
  modelId: string;
  /** ONNX model filename within the HuggingFace repo. Falls back to "model.onnx" if not specified. */
  onnxFile?: string;
  /** Approximate download size description (e.g. "~200 MB") */
  size: string;
  /** Short description */
  description: string;
  /** Whether this is a built-in model (cannot be edited or deleted) */
  builtin: boolean;
  /** Whether this is the default model for its tool */
  default?: boolean;
  /** Expected ONNX file size in bytes (for download progress estimation) */
  expectedBytes?: number;
  /**
   * Inference backend:
   * - 'ort': Raw ONNX Runtime Web (manual tensor I/O)
   * - 'transformers': @huggingface/transformers (auto pre/post-processing)
   */
  backend?: 'ort' | 'transformers';
  /**
   * Preferred execution device:
   * - 'webgpu': Use WebGPU — if unavailable, throw (no fallback).
   * - 'wasm': Force WASM execution.
   * @default 'webgpu'
   */
  device?: 'webgpu' | 'wasm';
}

/**
 * ModelCatalog — Generic config shape for any AI tool's model list.
 *
 * Holds the registered models (built-in + user-custom) and tracks which
 * model is currently active. Used as the base config for bgremover,
 * and extended by the combined AIToolsConfig.
 */
export interface ModelCatalog {
  [key: string]: unknown;
  /** All registered models (built-in + user-custom) */
  models: ModelEntry[];
  /** ID of the currently selected/active model */
  activeModelId: string;
}
