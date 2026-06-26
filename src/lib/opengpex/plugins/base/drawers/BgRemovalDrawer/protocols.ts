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
 * BgRemovalDrawer Plugin Protocols
 *
 * Defines constants and type contracts for the AI background removal drawer.
 * This drawer provides one-click background removal via local ONNX inference
 * running entirely in-browser (WebGPU / WASM fallback).
 *
 * Supports multiple models: users can select from built-in models or add
 * custom HuggingFace model repos.
 */

export const PLUGIN_ID = 'drawers.bg_removal';
export const PLUGIN_AUTHOR = 'opengpex';

/* Command IDs */
export const CMD_REMOVE_BG = 'cmd.remove_bg';
export const CMD_ABORT = 'cmd.abort';
export const CMD_OPEN_SETTINGS = 'cmd.open_settings';

/* Signal IDs */
export const SIGNAL_STATUS = 'signal.status';

/* Cross-plugin UIDs */
export const BG_REMOVAL_CMD_REMOVE_BG = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_REMOVE_BG}`;
export const BG_REMOVAL_SIGNAL_STATUS = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_STATUS}`;

/* Status types */
export type BgRemovalStage =
  | 'idle'
  | 'loading'       // Model being loaded into memory (from cache or initial import)
  | 'downloading'   // Genuine network download in progress
  | 'processing'    // Inference running
  | 'done'
  | 'error';

export interface BgRemovalStatus {
  [key: string]: unknown;
  stage: BgRemovalStage;
  /** Device being used: 'webgpu' | 'wasm' | null (undetermined) */
  device: 'webgpu' | 'wasm' | null;
  /** Model download progress (0-1), only valid during 'downloading' stage */
  downloadProgress: number;
  /** Downloaded bytes */
  downloadedBytes: number;
  /** Total bytes to download */
  totalBytes: number;
  /** Download speed in bytes/second */
  speedBps: number;
  /** Estimated time remaining in seconds */
  etaSeconds: number;
  /** Processing progress (0-1), only valid during 'processing' stage */
  processingProgress: number;
  /** Error message (only valid during 'error' stage) */
  errorMessage: string | null;
  /** Whether model is cached (subsequent loads skip download) */
  modelCached: boolean;
  /** Context snapshot for result validation */
  context: { frameId: string; layerId: string } | null;
  /** Total elapsed time in ms for the last completed inference */
  elapsedMs: number;
}

export const INITIAL_STATUS: BgRemovalStatus = {
  stage: 'idle',
  device: null,
  downloadProgress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  speedBps: 0,
  etaSeconds: 0,
  processingProgress: 0,
  errorMessage: null,
  modelCached: false,
  context: null,
  elapsedMs: 0,
};

// ─── Model Management ────────────────────────────────────────────────────────

/**
 * A single model entry in the model registry.
 * Built-in models cannot be edited or removed.
 */
export interface BgModelEntry {
  /** Unique identifier (usually same as modelId for built-ins) */
  id: string;
  /** Display name shown in the UI */
  name: string;
  /** HuggingFace model repository ID (e.g. "briaai/RMBG-1.4") */
  modelId: string;
  /** Approximate download size description */
  size: string;
  /** Short description */
  description: string;
  /** Whether this is a built-in model (cannot be edited or deleted) */
  builtin: boolean;
}

/**
 * Plugin configuration (persisted via pluginConfig / localStorage).
 */
export interface BgRemovalConfig {
  [key: string]: unknown;
  /** All registered models (built-in + user-custom) */
  models: BgModelEntry[];
  /** ID of the currently selected/active model */
  activeModelId: string;
}

// ─── Built-in Models ─────────────────────────────────────────────────────────

export const BUILTIN_MODELS: BgModelEntry[] = [
  {
    id: 'briaai/RMBG-1.4',
    name: 'RMBG 1.4',
    modelId: 'briaai/RMBG-1.4',
    size: '~176 MB',
    description: 'Fast, general-purpose background removal',
    builtin: true,
  },
  {
    id: 'OS-Software/InSPyReNet-SwinB-Plus-Ultra-ONNX',
    name: 'InSPyReNet Ultra',
    modelId: 'OS-Software/InSPyReNet-SwinB-Plus-Ultra-ONNX',
    size: '~300 MB',
    description: 'Sharp edges, excellent for products & e-commerce',
    builtin: true,
  },
];

export const DEFAULT_BG_REMOVAL_CONFIG: BgRemovalConfig = {
  models: [...BUILTIN_MODELS],
  activeModelId: BUILTIN_MODELS[0].id,
};
