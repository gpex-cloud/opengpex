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
 * ComfyBridgeDrawer Plugin Protocols
 *
 * Defines type contracts, constants, and default configurations for the ComfyUI Bridge plugin.
 * Connects to user's local ComfyUI instance for advanced AI image processing.
 */

export const PLUGIN_ID = 'drawers.comfy_bridge';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Command IDs ───────────────────────────────────────────────────────────────

export const CMD_RUN = 'cmd.run_workflow';
export const CMD_TEST_CONNECTION = 'cmd.test_connection';
export const CMD_OPEN_SETTINGS = 'cmd.open_settings';

// ─── ComfyUI Environment Definition ───────────────────────────────────────────

export type ConnectionStatus = 'unknown' | 'healthy' | 'unhealthy' | 'checking';

/**
 * Connection mode:
 * - 'auto': Auto-detect (use direct for localhost when app is on cloud, proxy for local dev)
 * - 'direct': Browser directly fetches ComfyUI (requires ComfyUI --enable-cors-header)
 * - 'proxy': Route through /api/comfy/ Next.js proxy (only works if server can reach ComfyUI)
 */
export type ConnectionMode = 'auto' | 'direct' | 'proxy';

export interface ComfyEnvironment {
  /** Unique ID */
  id: string;
  /** Display name (e.g. "Local RTX 5090" / "Remote A100") */
  name: string;
  /** ComfyUI base URL (e.g. 'http://localhost:8188') */
  url: string;
  /** Connection mode for this environment */
  connectionMode: ConnectionMode;
}

// ─── Execution State (transient, not persisted) ────────────────────────────────

/** Execution phase state machine for UI progress display */
export type ExecutionPhase =
  | 'idle'            // Not running
  | 'uploading'      // Uploading input image to ComfyUI
  | 'queued'         // Prompt submitted, waiting for ComfyUI to start
  | 'loading-model'  // Execution started but no progress yet (cold start / model loading)
  | 'inferring'      // Received progress messages, actively generating
  | 'downloading';   // Inference complete, downloading result images

export interface ExecutionProgress {
  /** Current step */
  value: number;
  /** Total steps */
  max: number;
  /** prompt_id being tracked */
  promptId: string;
}

/** Full transient execution state exposed to UI */
export interface ExecutionState {
  phase: ExecutionPhase;
  progress: ExecutionProgress | null;
  /** Timestamp when current execution started (for elapsed timer) */
  startedAt: number | null;
  /** Active prompt_id (for cancellation) */
  promptId: string | null;
}

export const INITIAL_EXECUTION_STATE: ExecutionState = {
  phase: 'idle',
  progress: null,
  startedAt: null,
  promptId: null,
};

// ─── User Workflow Types ───────────────────────────────────────────────────────

export interface ExposedParam {
  /** Node ID in the workflow, e.g. "37" */
  nodeId: string;
  /** Node class_type, e.g. "UNETLoader" */
  nodeClass: string;
  /** Node display title from _meta.title, e.g. "CLIP Text Encode (Positive)" */
  nodeTitle: string;
  /** Input field name within the node, e.g. "unet_name" or "weight_dtype" */
  paramName: string;
  /** Current value as string (serialized from the workflow template default) */
  paramValue: string;
  /** Parameter type: text input, number input, prompt textarea, or combo dropdown */
  type: 'text' | 'number' | 'prompt' | 'combo';
  /** Type-specific config */
  config: TextConfig | NumberConfig | PromptConfig | ComboConfig;
}

export interface TextConfig {
  default: string;
  placeholder?: string;
  /** Whether to render as multiline textarea (filled in after /object_info sync) */
  multiline?: boolean;
}

export interface NumberConfig {
  default: number;
  /** Number of decimal places (0=integer, 1=tenths, 2=hundredths). Controls step and display. */
  decimals: number;
  /** Minimum value (filled in after /object_info sync) */
  min?: number;
  /** Maximum value (filled in after /object_info sync) */
  max?: number;
  /** Step size (filled in after /object_info sync) */
  step?: number;
}

export interface PromptConfig {
  default: string;
  placeholder?: string;
  /** positive or negative prompt (affects label color) */
  sentiment: 'positive' | 'negative';
}

export interface ComboConfig {
  default: string;
  /** Available options (empty until /object_info sync; fallback to text input when empty) */
  options: string[];
}

/** Workflow mode: img2img requires input image, txt2img generates from scratch */
export type WorkflowMode = 'img2img' | 'txt2img';

/** Input source for img2img workflows */
export type InputSource = 'active-layer' | 'merged-frame';

export interface UserWorkflow {
  id: string;
  name: string;
  description: string;
  /** Workflow mode — auto-detected from presence of LoadImage node */
  mode: WorkflowMode;
  /** User-uploaded original ComfyUI API format JSON */
  template: Record<string, unknown>;
  /** User-marked exposed parameters */
  exposedParams: ExposedParam[];
  /** Auto-detected input node ID (class_type === 'LoadImage') */
  inputNodeId: string | null;
  /** Auto-detected output node ID (class_type === 'SaveImage' / 'PreviewImage') */
  outputNodeId: string | null;
  /** Import timestamp */
  createdAt: number;
}

// ─── Execution History ─────────────────────────────────────────────────────────

/** Single execution history record (text-only, no images stored) */
export interface ExecutionRecord {
  /** Unique ID */
  id: string;
  /** Execution timestamp (ms since epoch) */
  timestamp: number;
  /** Workflow name at time of execution */
  workflowName: string;
  /** Workflow ID (for "Reuse Params" feature) */
  workflowId: string;
  /** Execution mode */
  mode: WorkflowMode;
  /** Full parameter snapshot used (contains prompt / seed / other exposed params) */
  params: Record<string, unknown>;
  /** Actual seed used (including randomized ones) */
  seed: number | null;
  /** Positive prompt text (for quick list preview) */
  positivePrompt: string | null;
  /** Execution duration in ms (null if failed/cancelled before completion) */
  durationMs: number | null;
  /** Execution result status */
  status: 'success' | 'failed' | 'cancelled';
  /** Error message (only when status === 'failed') */
  error?: string;
  /** Number of output frames produced (only when status === 'success') */
  outputCount?: number;
  /** ComfyUI environment name used */
  envName: string;
}

// ─── Plugin Config (persisted via pluginConfig) ────────────────────────────────

export interface ComfyBridgeConfig {
  /** Multiple ComfyUI environments */
  environments: ComfyEnvironment[];
  /** Currently active environment ID */
  activeEnvironmentId: string;
  /** Currently selected workflow ID (null = none selected) */
  activeWorkflowId: string | null;
  /** User-imported custom workflows */
  workflows: UserWorkflow[];
  /** Runtime param values for custom workflows (keyed by param path) */
  workflowParamValues: Record<string, unknown>;
  /** Input source for img2img workflows: single layer or merged frame */
  inputSource: InputSource;
  /** Param paths for which seed is randomized on each run */
  randomSeedPaths: string[];
  /** Execution history records (newest first, no upper limit) */
  executionHistory: ExecutionRecord[];
}

// ─── Default Config ────────────────────────────────────────────────────────────

export const DEFAULT_COMFY_CONFIG: ComfyBridgeConfig = {
  environments: [
    { id: 'default', name: 'Local', url: 'http://localhost:8188', connectionMode: 'auto' },
  ],
  activeEnvironmentId: 'default',
  activeWorkflowId: null,
  workflows: [],
  workflowParamValues: {},
  inputSource: 'active-layer',
  randomSeedPaths: [],
  executionHistory: [],
};

