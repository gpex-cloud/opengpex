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
 * Workflow Parser — Analyzes ComfyUI API-format workflow JSON.
 *
 * Automatically detects:
 * - LoadImage nodes (input injection point)
 * - SaveImage / PreviewImage nodes (output collection point)
 * - Numeric / text inputs suitable for parameter exposure
 */

import type { UserWorkflow, ExposedParam, WorkflowMode } from '../protocols';

// ─── Types for ComfyUI API-format workflow ─────────────────────────────────────

interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

type ComfyWorkflow = Record<string, ComfyNode>;

// ─── Node class_type constants ─────────────────────────────────────────────────

const INPUT_NODE_TYPES = ['LoadImage', 'LoadImageMask'];
const OUTPUT_NODE_TYPES = ['SaveImage', 'PreviewImage'];

// ─── Parse Result ──────────────────────────────────────────────────────────────

export interface ParseResult {
  valid: boolean;
  error?: string;
  inputNodeId: string | null;
  outputNodeId: string | null;
  /** Candidate parameters that can be exposed to UI */
  candidateParams: CandidateParam[];
  nodeCount: number;
}

export interface CandidateParam {
  /** node_id.input_name format */
  path: string;
  /** Auto-generated label: "NodeTitle.InputName" or "#id ClassName.InputName" */
  label: string;
  /** Detected value type */
  valueType: 'number' | 'string' | 'boolean';
  /** Current default value */
  currentValue: unknown;
  /** Node class_type for context */
  nodeClass: string;
}

// ─── Main Parser ───────────────────────────────────────────────────────────────

/**
 * Parses a ComfyUI API-format workflow JSON and extracts metadata.
 */
export function parseWorkflowJson(json: unknown): ParseResult {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { valid: false, error: 'Invalid JSON: expected a non-array object', inputNodeId: null, outputNodeId: null, candidateParams: [], nodeCount: 0 };
  }

  const workflow = json as ComfyWorkflow;
  const nodeIds = Object.keys(workflow);

  // Basic validation: must have at least one node with class_type
  if (nodeIds.length === 0) {
    return { valid: false, error: 'Empty workflow: no nodes found', inputNodeId: null, outputNodeId: null, candidateParams: [], nodeCount: 0 };
  }

  const hasValidNodes = nodeIds.some(id => {
    const node = workflow[id];
    return node && typeof node.class_type === 'string';
  });

  if (!hasValidNodes) {
    return { valid: false, error: 'Invalid format: nodes must have class_type field. Use "Save (API Format)" from ComfyUI.', inputNodeId: null, outputNodeId: null, candidateParams: [], nodeCount: 0 };
  }

  // Find input and output nodes
  let inputNodeId: string | null = null;
  let outputNodeId: string | null = null;

  for (const id of nodeIds) {
    const node = workflow[id];
    if (!node?.class_type) continue;

    if (!inputNodeId && INPUT_NODE_TYPES.includes(node.class_type)) {
      inputNodeId = id;
    }
    if (!outputNodeId && OUTPUT_NODE_TYPES.includes(node.class_type)) {
      outputNodeId = id;
    }
  }

  // Extract candidate parameters
  const candidateParams: CandidateParam[] = [];

  for (const id of nodeIds) {
    const node = workflow[id];
    if (!node?.class_type || !node.inputs) continue;

    // Skip input/output nodes — their params are auto-managed
    if (INPUT_NODE_TYPES.includes(node.class_type) || OUTPUT_NODE_TYPES.includes(node.class_type)) {
      continue;
    }

    const nodeTitle = node._meta?.title || node.class_type;

    for (const [inputName, value] of Object.entries(node.inputs)) {
      // Skip link references (arrays like [nodeId, outputIndex])
      if (Array.isArray(value)) continue;

      // Only expose scalar values
      if (typeof value === 'number') {
        candidateParams.push({
          path: `${id}.${inputName}`,
          label: `${nodeTitle}.${inputName}`,
          valueType: 'number',
          currentValue: value,
          nodeClass: node.class_type,
        });
      } else if (typeof value === 'string') {
        candidateParams.push({
          path: `${id}.${inputName}`,
          label: `${nodeTitle}.${inputName}`,
          valueType: 'string',
          currentValue: value,
          nodeClass: node.class_type,
        });
      } else if (typeof value === 'boolean') {
        candidateParams.push({
          path: `${id}.${inputName}`,
          label: `${nodeTitle}.${inputName}`,
          valueType: 'boolean',
          currentValue: value,
          nodeClass: node.class_type,
        });
      }
    }
  }

  return {
    valid: true,
    inputNodeId,
    outputNodeId,
    candidateParams,
    nodeCount: nodeIds.length,
  };
}

// ─── Known Param Decimals Definitions ──────────────────────────────────────────

/**
 * Known ComfyUI parameter names with their decimal precision.
 * Key: lowercase input_name, Value: number of decimal places.
 *
 * Examples:
 * - cfg: 1 decimal (e.g. 7.5)
 * - denoise / denoising_strength: 2 decimals (e.g. 0.75)
 * - steps / seed / width / height: 0 decimals (integer)
 */
const KNOWN_PARAM_DECIMALS: Record<string, number> = {
  // Integer params (0 decimals)
  steps: 0,
  seed: 0,
  width: 0,
  height: 0,
  batch_size: 0,
  start_at_step: 0,
  end_at_step: 0,
  // 1 decimal params
  cfg: 1,
  cfg_scale: 1,
  guidance: 1,
  scale: 1,
  upscale_by: 1,
  // 2 decimal params
  denoise: 2,
  denoising_strength: 2,
  strength: 2,
  weight: 2,
  noise: 2,
  blend: 2,
  opacity: 2,
};

/**
 * Determines the decimals for a numeric param.
 * Checks known params first, then infers from the default value.
 */
function getParamDecimals(inputName: string, value: number): number {
  // Check known params
  const known = KNOWN_PARAM_DECIMALS[inputName];
  if (known !== undefined) return known;

  // Infer from value: count decimal places in the current value
  const str = String(value);
  const dotIdx = str.indexOf('.');
  if (dotIdx === -1) return 0; // integer
  return Math.min(str.length - dotIdx - 1, 3); // cap at 3
}

// ─── Param Type Inference ──────────────────────────────────────────────────────

/**
 * Infers UI control type for a candidate parameter.
 *
 * Logic:
 * - If input_name or node label contains "prompt" → prompt textarea
 *   - Sub-check: if contains "negative" → negative sentiment; otherwise → positive
 * - If valueType is 'number' → number input (with decimals from known definitions)
 * - Otherwise (string, boolean) → text input
 */
function inferParamType(candidate: CandidateParam): ExposedParam | null {
  const inputName = candidate.path.split('.').pop()?.toLowerCase() || '';
  const labelLower = candidate.label.toLowerCase();

  // Prompt detection: if input name or label contains "prompt"
  const isPrompt = inputName.includes('prompt') || labelLower.includes('prompt');

  if (isPrompt && candidate.valueType === 'string') {
    // Check if negative or positive
    const isNegative = inputName.includes('negative') || labelLower.includes('negative');
    return {
      path: candidate.path,
      label: candidate.label,
      type: 'prompt',
      config: {
        default: candidate.currentValue as string,
        placeholder: isNegative ? 'Negative prompt...' : 'Describe what you want...',
        sentiment: isNegative ? 'negative' : 'positive',
      },
    };
  }

  if (candidate.valueType === 'number') {
    const val = candidate.currentValue as number;
    const decimals = getParamDecimals(inputName, val);
    return {
      path: candidate.path,
      label: candidate.label,
      type: 'number',
      config: {
        default: val,
        placeholder: String(val),
        decimals,
      },
    };
  }

  // String, boolean, or anything else → text input
  return {
    path: candidate.path,
    label: candidate.label,
    type: 'text',
    config: {
      default: String(candidate.currentValue ?? ''),
      placeholder: `Enter ${inputName}`,
    },
  };
}

/**
 * Creates a UserWorkflow from parsed result + user inputs.
 */
export function createUserWorkflow(
  name: string,
  description: string,
  template: Record<string, unknown>,
  parseResult: ParseResult,
  selectedParams: string[], // paths that user chose to expose
): UserWorkflow {
  const exposedParams: ExposedParam[] = [];

  for (const path of selectedParams) {
    const candidate = parseResult.candidateParams.find(p => p.path === path);
    if (!candidate) continue;

    const param = inferParamType(candidate);
    if (param) exposedParams.push(param);
  }

  // Detect workflow mode: if has LoadImage input node → img2img, else → txt2img
  const mode: WorkflowMode = parseResult.inputNodeId ? 'img2img' : 'txt2img';

  return {
    id: `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description,
    mode,
    template,
    exposedParams,
    inputNodeId: parseResult.inputNodeId,
    outputNodeId: parseResult.outputNodeId,
    createdAt: Date.now(),
  };
}

// ─── Workflow Template Injector ─────────────────────────────────────────────────

/**
 * Injects parameter values and input image into a workflow template.
 *
 * @param template - The original workflow JSON (will be deep-cloned, not mutated)
 * @param params - Map of param path → value to inject (e.g. {"4.denoise": 0.8, "6.text": "a cat"})
 * @param inputImage - If provided, replaces the LoadImage node's `image` field
 * @param inputNodeId - The node ID of the LoadImage node
 * @returns A ready-to-submit workflow JSON
 */
export function injectWorkflowParams(
  template: Record<string, unknown>,
  params: Record<string, unknown>,
  inputImage?: string,
  inputNodeId?: string | null,
): Record<string, unknown> {
  // Deep clone to avoid mutating the stored template
  const workflow = JSON.parse(JSON.stringify(template)) as Record<string, ComfyNode>;

  // Inject exposed parameter values
  for (const [path, value] of Object.entries(params)) {
    const dotIdx = path.indexOf('.');
    if (dotIdx === -1) continue;
    const nodeId = path.slice(0, dotIdx);
    const inputName = path.slice(dotIdx + 1);

    if (workflow[nodeId]?.inputs) {
      workflow[nodeId].inputs[inputName] = value;
    }
  }

  // Inject input image filename into LoadImage node
  if (inputImage && inputNodeId && workflow[inputNodeId]?.inputs) {
    workflow[inputNodeId].inputs['image'] = inputImage;
  }

  return workflow as Record<string, unknown>;
}

// ─── Node Dependency Validation ────────────────────────────────────────────────

export interface NodeValidationResult {
  valid: boolean;
  /** Node class_types used in workflow but not found in installedNodes */
  missingNodes: string[];
  /** Total unique node types used in workflow */
  usedNodeTypes: string[];
}

/**
 * Validates that all node types in a workflow are available in the target ComfyUI instance.
 *
 * @param template - Workflow JSON to validate
 * @param installedNodes - List of installed node class_types from /object_info
 * @returns Validation result with missing nodes list
 */
export function validateWorkflowNodes(
  template: Record<string, unknown>,
  installedNodes: string[],
): NodeValidationResult {
  const installedSet = new Set(installedNodes);
  const usedNodeTypes = new Set<string>();

  const workflow = template as Record<string, ComfyNode>;
  for (const nodeId of Object.keys(workflow)) {
    const node = workflow[nodeId];
    if (node?.class_type) {
      usedNodeTypes.add(node.class_type);
    }
  }

  const usedArray = Array.from(usedNodeTypes).sort();
  const missingNodes = usedArray.filter(t => !installedSet.has(t));

  return {
    valid: missingNodes.length === 0,
    missingNodes,
    usedNodeTypes: usedArray,
  };
}

// ─── History Workflow Import Utilities ──────────────────────────────────────────

/**
 * Summary of a workflow extracted from ComfyUI /history.
 * Used for displaying selection UI when importing from server.
 */
export interface HistoryWorkflowSummary {
  /** The prompt_id from ComfyUI history */
  promptId: string;
  /** The raw API-format workflow object (prompt[2]) */
  workflow: Record<string, unknown>;
  /** Number of nodes in the workflow */
  nodeCount: number;
  /** Key node types (sampler, controlnet, etc.) for display */
  keyNodes: string[];
  /** Checkpoint/model name if detected */
  modelName: string | null;
  /** Whether it completed successfully */
  completed: boolean;
  /** Structural fingerprint for deduplication */
  fingerprint: string;
  /** Creation timestamp (from extra_data) */
  createdAt: string | null;
  /** Client ID that submitted the prompt */
  clientId: string | null;
}

/** Key node types to highlight in the summary */
const KEY_NODE_TYPES = [
  'KSampler', 'KSamplerAdvanced', 'SamplerCustom',
  'ControlNetApply', 'ControlNetApplyAdvanced',
  'IPAdapter', 'IPAdapterAdvanced',
  'LoraLoader', 'LoraLoaderModelOnly',
  'VAEDecode', 'VAEEncode',
  'UpscaleModelLoader', 'ImageUpscaleWithModel',
];

/** Node types that hold model/checkpoint names */
const MODEL_LOADER_TYPES = ['CheckpointLoaderSimple', 'CheckpointLoader', 'UNETLoader'];

/**
 * Extracts a workflow summary from a ComfyUI history entry.
 */
export function summarizeHistoryEntry(promptId: string, entry: { prompt: unknown[]; status: { completed: boolean } }): HistoryWorkflowSummary | null {
  // The workflow is at entry.prompt[2] (API format)
  const workflow = entry.prompt?.[2];
  if (!workflow || typeof workflow !== 'object') return null;

  // Extract creation time and client_id from extra_data (prompt[3])
  const extraData = entry.prompt?.[3] as Record<string, unknown> | undefined;
  let createdAt: string | null = null;
  let clientId: string | null = null;
  if (extraData) {
    // Client ID
    if (typeof extraData.client_id === 'string') {
      clientId = extraData.client_id;
    }
    // Try common timestamp fields (ComfyUI uses create_time)
    const ts = extraData.create_time || extraData.created_at || extraData.timestamp || extraData.creation_time;
    if (typeof ts === 'string') {
      createdAt = ts;
    } else if (typeof ts === 'number') {
      createdAt = new Date(ts * 1000).toLocaleString();
    }
  }
  // Fallback: use prompt[0] which is often queue number/timestamp
  if (!createdAt && typeof entry.prompt?.[0] === 'number') {
    const queueNum = entry.prompt[0] as number;
    // If it looks like a unix timestamp (> year 2020), use it
    if (queueNum > 1577836800) {
      createdAt = new Date(queueNum * 1000).toLocaleString();
    }
  }

  const wf = workflow as Record<string, ComfyNode>;
  const nodeIds = Object.keys(wf);
  if (nodeIds.length === 0) return null;

  // Extract key node types
  const classTypes = new Set<string>();
  let modelName: string | null = null;

  for (const id of nodeIds) {
    const node = wf[id];
    if (!node?.class_type) continue;
    classTypes.add(node.class_type);

    // Detect model name
    if (!modelName && MODEL_LOADER_TYPES.includes(node.class_type)) {
      const ckptName = node.inputs?.ckpt_name || node.inputs?.unet_name;
      if (typeof ckptName === 'string') {
        // Strip path and extension for display: "models/v1-5-pruned.safetensors" → "v1-5-pruned"
        modelName = ckptName.split('/').pop()?.replace(/\.(safetensors|ckpt|pt|bin)$/i, '') || ckptName;
      }
    }
  }

  const keyNodes = KEY_NODE_TYPES.filter(t => classTypes.has(t));

  // Generate structural fingerprint (class_types sorted + node count bucket)
  const sortedTypes = Array.from(classTypes).sort();
  const fingerprint = sortedTypes.join('|');

  return {
    promptId,
    workflow: workflow as Record<string, unknown>,
    nodeCount: nodeIds.length,
    keyNodes,
    modelName,
    completed: entry.status?.completed ?? false,
    fingerprint,
    createdAt,
    clientId,
  };
}

/**
 * Deduplicates history workflow summaries by structural fingerprint.
 * Keeps only the most recent entry (first occurrence since history is reverse-chronological).
 */
export function deduplicateHistoryWorkflows(summaries: HistoryWorkflowSummary[]): HistoryWorkflowSummary[] {
  const seen = new Set<string>();
  const result: HistoryWorkflowSummary[] = [];

  for (const summary of summaries) {
    if (seen.has(summary.fingerprint)) continue;
    seen.add(summary.fingerprint);
    result.push(summary);
  }

  return result;
}

/**
 * Generates a human-readable name for a workflow based on its key nodes.
 * E.g. "KSampler + ControlNet" or "KSampler (basic)"
 */
export function generateWorkflowName(summary: HistoryWorkflowSummary): string {
  const { keyNodes, modelName } = summary;

  // Build name from key nodes
  const samplers = keyNodes.filter(n => n.startsWith('KSampler') || n === 'SamplerCustom');
  const extras = keyNodes.filter(n => !n.startsWith('KSampler') && n !== 'SamplerCustom' && !n.startsWith('VAE'));

  let name = samplers.length > 0 ? samplers[0] : 'Workflow';
  if (extras.length > 0) {
    // Show first 2 extras max
    name += ' + ' + extras.slice(0, 2).join(' + ');
  } else if (samplers.length > 0) {
    name += ' (basic)';
  }

  // Append model short name if available
  if (modelName) {
    // Truncate long model names
    const shortModel = modelName.length > 20 ? modelName.slice(0, 20) + '…' : modelName;
    name += ` • ${shortModel}`;
  }

  return name;
}
