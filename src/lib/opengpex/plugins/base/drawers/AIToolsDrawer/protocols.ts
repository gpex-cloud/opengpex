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
 * BgRemoverDrawer Plugin Protocols
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
export const CMD_DOWNLOAD_MODEL = 'cmd.download_model';
export const CMD_ABORT = 'cmd.abort';
export const CMD_OPEN_SETTINGS = 'cmd.open_settings';

/** Segmentation encode command — encodes a layer image into SAM embedding */
export const CMD_SEG_ENCODE = 'cmd.seg_encode';
/** Segmentation decode command — decodes prompts against cached embedding */
export const CMD_SEG_DECODE = 'cmd.seg_decode';
/** Segment All Objects — auto grid prompts + NMS → all objects in image */
export const CMD_SEG_ALL = 'cmd.seg_all';

/* Signal IDs */
export const SIGNAL_STATUS = 'signal.status';

/* Cross-plugin UIDs — see AIToolsDrawerAPI facade at bottom of file */

/* Status types */
export type BgRemoverStage =
  | 'idle'
  | 'loading'       // Model being loaded into memory (from cache or initial import)
  | 'downloading'   // Genuine network download in progress
  | 'processing'    // Inference running
  | 'done'
  | 'error';

export interface BgRemoverStatus {
  [key: string]: unknown;
  stage: BgRemoverStage;
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

export const INITIAL_STATUS: BgRemoverStatus = {
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
export interface BgRemoverConfig {
  [key: string]: unknown;
  /** All registered models (built-in + user-custom) */
  models: BgModelEntry[];
  /** ID of the currently selected/active model */
  activeModelId: string;
}

// ─── Built-in Models ─────────────────────────────────────────────────────────

export const BUILTIN_MODELS: BgModelEntry[] = [
  {
    id: 'OS-Software/InSPyReNet-SwinB-Plus-Ultra-ONNX',
    name: 'InSPyReNet Ultra',
    modelId: 'OS-Software/InSPyReNet-SwinB-Plus-Ultra-ONNX',
    size: '~300 MB',
    description: 'Sharp edges, excellent for products & e-commerce',
    builtin: true,
  },
  {
    id: 'briaai/RMBG-1.4',
    name: 'RMBG 1.4',
    modelId: 'briaai/RMBG-1.4',
    size: '~176 MB',
    description: 'Fast, general-purpose background removal',
    builtin: true,
  },
];

export const DEFAULT_BG_REMOVAL_CONFIG: BgRemoverConfig = {
  models: [...BUILTIN_MODELS],
  activeModelId: BUILTIN_MODELS[0].id,
};

// ─── Segmentation Model Management ──────────────────────────────────────────

export const SIGNAL_SEG_STATUS = 'signal.seg_status';
/** Active tab within the AITools drawer ('bg-removal' | 'segmentation') */
export const SIGNAL_ACTIVE_TAB = 'signal.active_tab';

export type SegStage =
  | 'idle'
  | 'downloading'
  | 'encoding'
  | 'decoding'
  | 'ready'       // Embedding cached, awaiting prompts
  | 'error';

export interface SegStatus {
  [key: string]: unknown;
  stage: SegStage;
  device: 'webgpu' | 'wasm' | null;
  downloadProgress: number;
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number;
  downloadFile: string | null;
  encodeProgress: number;
  errorMessage: string | null;
  embeddingReady: boolean;
  /** Asset ID of the layer with a warm embedding */
  embeddingAssetId: string | null;
  /** Last decode results (up to 3 candidates) */
  candidates: Array<{
    rings: { x: number; y: number }[][];
    score: number;
  }>;
  /** Index of the currently active candidate in clipBoxes */
  activeCandidateIdx: number;
  /** Performance stats from last decode */
  lastDecodeMs: number;
  /** Total elapsed ms */
  elapsedMs: number;
}

export const INITIAL_SEG_STATUS: SegStatus = {
  stage: 'idle',
  device: null,
  downloadProgress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  speedBps: 0,
  etaSeconds: 0,
  downloadFile: null,
  encodeProgress: 0,
  errorMessage: null,
  embeddingReady: false,
  embeddingAssetId: null,
  candidates: [],
  activeCandidateIdx: 0,
  lastDecodeMs: 0,
  elapsedMs: 0,
};

export interface SegModelEntry {
  id: string;
  name: string;
  modelId: string;
  size: string;
  description: string;
  builtin: boolean;
  default?: boolean;
  type: 'interactive' | 'auto';
}

export const BUILTIN_SEG_MODELS: SegModelEntry[] = [
  {
    id: 'SharpAI/sam2-hiera-tiny-onnx',
    name: 'SAM 2.1 Tiny',
    modelId: 'SharpAI/sam2-hiera-tiny-onnx',
    size: '~40 MB',
    description: 'Recommended — fast interactive segmentation',
    builtin: true,
    default: true,
    type: 'interactive',
  },
  {
    id: 'SharpAI/sam2-hiera-small-onnx',
    name: 'SAM 2.1 Small',
    modelId: 'SharpAI/sam2-hiera-small-onnx',
    size: '~50 MB',
    description: 'Higher accuracy, better edge detail',
    builtin: true,
    type: 'interactive',
  },
  {
    id: 'SharpAI/sam2-hiera-large-onnx',
    name: 'SAM 2.1 Large',
    modelId: 'SharpAI/sam2-hiera-large-onnx',
    size: '~300 MB',
    description: 'Maximum precision — hair, fur, fine edges',
    builtin: true,
    type: 'interactive',
  },
];

export interface SegConfig {
  [key: string]: unknown;
  models: SegModelEntry[];
  activeModelId: string;
}

export const DEFAULT_SEG_CONFIG: SegConfig = {
  models: [...BUILTIN_SEG_MODELS],
  activeModelId: BUILTIN_SEG_MODELS[0].id,
};

/** Combined plugin config (BgRemoval + Segmentation) */
export interface AIToolsConfig extends BgRemoverConfig {
  seg: SegConfig;
}

export const DEFAULT_AI_TOOLS_CONFIG: AIToolsConfig = {
  ...DEFAULT_BG_REMOVAL_CONFIG,
  seg: DEFAULT_SEG_CONFIG,
};

// ─── Segmentation Cross-Plugin Public Types ──────────────────────────────────
//
// These types form the PUBLIC CONTRACT for external consumers (e.g. ClipOverlay).
// Internal implementation details (Worker messages, ONNX sessions) stay in
// `worker/seg-protocol.ts` and are NOT exported here.

/**
 * SegPrompt — User interaction prompt for SAM decoding.
 *
 * Coordinates are in **image-local** space (pixels relative to the layer's
 * intrinsic width × height). The caller (e.g. SAM interaction handler) is
 * responsible for projecting world/canvas coords → layer-local before
 * submitting.
 */
export type SegPrompt =
  | { type: 'point'; x: number; y: number; label: 0 | 1 }  // 0=background, 1=foreground
  | { type: 'box'; x1: number; y1: number; x2: number; y2: number };

/** Payload for `CMD_SEG_ENCODE` — encode a layer image into SAM embedding. */
export interface SegEncodePayload {
  /** RGBA pixel buffer (Transferable — zero-copy to Worker). */
  imageData: {
    data: ArrayBuffer;
    width: number;
    height: number;
  };
  /** Context for stale-response validation. */
  context: {
    frameId: string;
    layerId: string;
    assetId: string;
  };
}

/** Result of `CMD_SEG_ENCODE`. */
export interface SegEncodeResult {
  success: boolean;
  error?: string;
}

/** Payload for `CMD_SEG_DECODE` — decode prompts against a cached embedding. */
export interface SegDecodePayload {
  prompts: SegPrompt[];
  /** Context — must match the most recent encode's context. */
  context: {
    frameId: string;
    layerId: string;
    assetId: string;
  };
}

/** Result of `CMD_SEG_DECODE`. */
export interface SegDecodeResult {
  success: boolean;
  /** Up to 3 candidate masks sorted by score descending. */
  masks?: Array<{
    rings: { x: number; y: number }[][];
    score: number;
  }>;
  /** Performance stats. */
  debug?: {
    deviceUsed: 'webgpu' | 'wasm';
    encodeMs?: number;
    decodeMs?: number;
    postProcessMs?: number;
    totalMs: number;
  };
  error?: string;
}

// ─── Cross-Plugin Typed Facade ──────────────────────────────────────────────────

/**
 * AIToolsDrawerAPI: Structured cross-plugin facade for external consumers.
 *
 * Usage (from ClipOverlay or any other plugin):
 *   import { AIToolsDrawerAPI } from '...drawers/AIToolsDrawer/protocols';
 *
 *   // Encode:
 *   const encResult = await actions.executeCommand<SegEncodePayload, Promise<SegEncodeResult>>(
 *     AIToolsDrawerAPI.commands.segEncode.uid, payload
 *   );
 *
 *   // Decode:
 *   const decResult = await actions.executeCommand<SegDecodePayload, Promise<SegDecodeResult>>(
 *     AIToolsDrawerAPI.commands.segDecode.uid, payload
 *   );
 *
 *   // Read status:
 *   state.getStateSignal(AIToolsDrawerAPI.signals.segStatus);
 */
export const AIToolsDrawerAPI = {
  signals: {
    /** Segmentation status (stage, progress, embedding state, candidates) */
    segStatus: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_SEG_STATUS}` as const,
    /** Background removal status */
    bgStatus: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_STATUS}` as const,
    /** Active tab within the AITools drawer ('bg-removal' | 'segmentation') */
    activeTab: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_ACTIVE_TAB}` as const,
  },
  commands: {
    /** Encode image → SAM embedding (async, ~500ms first time). */
    segEncode: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SEG_ENCODE}` } as { uid: string; _payload: SegEncodePayload; _result: Promise<SegEncodeResult> },
    /** Decode prompts → polygon masks (async, ~10ms). */
    segDecode: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SEG_DECODE}` } as { uid: string; _payload: SegDecodePayload; _result: Promise<SegDecodeResult> },
  },
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;
