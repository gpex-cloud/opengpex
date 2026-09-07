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
 * AIBridgeDrawer Plugin Protocols
 *
 * Type contracts, constants and defaults for the AI Bridge plugin.
 *
 * Architecture: the user configures *endpoints* (base URL + API key) and picks
 * which *provider* each one belongs to. Provider behaviour lives in
 * ./adapters/providers/<provider>.ts and is selected at configuration time — the runtime
 * follows exactly one code path, with no protocol probing or fallback.
 */

export const PLUGIN_ID = 'drawers.ai_bridge';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Command IDs ───────────────────────────────────────────────────────────────

export const CMD_GENERATE = 'cmd.generate';
export const CMD_DESCRIBE = 'cmd.describe';
export const CMD_OPEN_SETTINGS = 'cmd.open_settings';
export const CMD_FETCH_MODELS = 'cmd.fetch_models';
export const CMD_TOGGLE_AGENT_CHAT = 'cmd.toggle_agent_chat';

/**
 * @deprecated Use PluginService.isBusy() instead.
 * Kept for backward compatibility with any external consumers.
 */
export const SIGNAL_IS_GENERATING = 'signal.is_generating';
/** @deprecated Use PluginService.isBusy() instead. */
export const AI_BRIDGE_SIGNAL_IS_GENERATING = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_IS_GENERATING}`;

// ─── Re-exports: adapter layer contracts ───────────────────────────────────────
//
// Declared as explicit aliases (not `export ... from`) so the plugin contract is
// introspectable — `pnpm gen-plugin-types` scans this file for exported types.

import type {
  AIEndpoint as AIEndpointType,
  AIModelInfo as AIModelInfoType,
  ProviderFeatures as ProviderFeaturesType,
  ProviderCapabilities as ProviderCapabilitiesType,
  ProviderDefinition as ProviderDefinitionType,
  ImageGenRequest as ImageGenRequestType,
  ImageEditRequest as ImageEditRequestType,
  ChatMessage as ChatMessageType,
  AgentToolDef as AgentToolDefType,
  AgentToolCall as AgentToolCallType,
  AgentMessage as AgentMessageType,
} from './adapters/types';
import type {
  ModelModality as ModelModalityType,
  ModelCapabilityHints as ModelCapabilityHintsType,
} from './modality';

/** A configured access point: base URL + key + the provider it belongs to */
export type AIEndpoint = AIEndpointType;
/** A model as listed by an endpoint, annotated with its inferred modality */
export type AIModelInfo = AIModelInfoType;
/** Capability switches that drive UI visibility */
export type ProviderFeatures = ProviderFeaturesType;
/** Which tasks a provider can perform at all (hard fact, not inferred) */
export type ProviderCapabilities = ProviderCapabilitiesType;
/** A provider implementation (one per adapters/providers/<provider>.ts) */
export type ProviderDefinition = ProviderDefinitionType;
export type ImageGenRequest = ImageGenRequestType;
export type ImageEditRequest = ImageEditRequestType;
export type ChatMessage = ChatMessageType;
/** What a model can do: image / text / multi (vision) / unknown */
export type ModelModality = ModelModalityType;
/** Structured capability payload some services expose */
export type ModelCapabilityHints = ModelCapabilityHintsType;
/** Tool definition sent in a chat-completion request (OpenAI function calling format) */
export type AgentToolDef = AgentToolDefType;
/** A tool call returned by the assistant */
export type AgentToolCall = AgentToolCallType;
/** Agent conversation message — superset of ChatMessage */
export type AgentMessage = AgentMessageType;

export {
  PROVIDER_REGISTRY,
  DEFAULT_PROVIDER_KEY,
  getProvider,
  getAdapter,
} from './adapters/registry';

export {
  inferModality,
  resolveModality,
  modalityFromCapabilities,
  canProduceImage,
  canReadImage,
  modalityWarning,
  MODALITY_HINTS,
} from './modality';

// ─── AI Mode ───────────────────────────────────────────────────────────────────

export type AIMode = 'generate' | 'edit' | 'describe';

/** Input source for Edit/Describe mode: single layer or merged frame */
export type InputSource = 'active-layer' | 'merged-frame';

export const AI_MODE_META: Record<AIMode, { label: string }> = {
  describe: { label: 'Describe' },
  generate: { label: 'Generate' },
  edit: { label: 'Edit' },
};

/** Which model slot a task reads from */
export type ModelSlot = 'image' | 'text' | 'multi';

// ─── Agent Definition ───────────────────────────────────────────────────────────

/** Agent response style preset — controls verbosity, not capabilities. */
export type AgentBehaviorPreset = 'auto' | 'concise' | 'detailed';

/** An Agent configuration: which endpoint + model to use for conversation. */
export interface AgentDef {
  id: string;
  name: string;
  /** References config.endpoints[].id — carries baseUrl + apiKey + provider */
  endpointId: string;
  /** Model ID selected from the endpoint's cachedModels at configuration time */
  model: string;
  /** Behavior preset — controls response style, not capabilities. Default 'auto'. */
  behaviorPreset?: AgentBehaviorPreset;
}

// ─── Plugin Config (persisted via pluginConfig) ────────────────────────────────

export interface AIBridgeConfig {
  /** Configured access points (URL + key + provider) */
  endpoints: AIEndpoint[];
  activeEndpointId: string;
  /** Current AI mode */
  mode: AIMode;
  prompt: string;
  negativePrompt: string;
  /** -1 means random each time */
  seed: number;
  /** Image size as "WxH" string (free-form; not all models accept every value) */
  size: string;
  /** Input source for Edit/Describe: single layer or merged frame */
  inputSource: InputSource;
  /** Cached model list per endpoint ID */
  cachedModels: Record<string, AIModelInfo[]>;
  /** Generation history (most recent last) */
  generationHistory: GenerationRecord[];

  // ─── Agent (Phase 1) ───
  /** Whether the Agent dock button & chat panel are enabled */
  enableAgents?: boolean;
  /** Configured agents (each references an endpoint + model) */
  agents: AgentDef[];
  /** Currently active agent for conversation (null = none) */
  activeAgentId: string | null;
  /** Global agent chat sessions (persisted to IndexedDB via pluginConfig).
   *  Sessions are agent-independent — switching agents mid-conversation is allowed. */
  agentChatStore?: AgentChatStore;
}

// ─── Agent Knowledge (Phase 1.2) ───────────────────────────────────────────────

/** Cloud base URL — reads from env, falls back to production. */
const GPEX_CLOUD_URL = process.env.NEXT_PUBLIC_GPEX_CLOUD_URL || 'https://gpex.cloud';

/** Documentation search API endpoint used by the Agent's `search_docs` tool. */
export const GPEX_DOCS_API_URL = `${GPEX_CLOUD_URL}/api/docs`;

/** A single conversation session (agent-independent). */
export interface AgentChatSession {
  id: string;
  /** Auto-generated from first user message. */
  title: string;
  createdAt: number;
  messages: import('./adapters/types').AgentMessage[];
}

/** Global chat storage: all sessions + which one is active. */
export interface AgentChatStore {
  sessions: AgentChatSession[];
  activeSessionId: string | null;
}

// ─── Generation History Record ─────────────────────────────────────────────────

export interface GenerationRecord {
  id: string;
  timestamp: number;
  /** Endpoint name as shown to the user */
  provider: string;
  model: string;
  mode: AIMode;
  /** Record payload kind: image generation or text completion */
  kind: 'image' | 'text';
  prompt: string;
  negativePrompt: string;
  seed: number;
  size: string;
  success: boolean;
  error?: string;
  /** Duration in ms */
  durationMs: number;
}

// ─── Generation State (transient, component-local) ─────────────────────────────

export type GenerationStatus = 'idle' | 'generating' | 'success' | 'error';

export interface GenerationState {
  status: GenerationStatus;
  error: string | null;
  /** Elapsed ms for the last generation */
  elapsedMs: number;
}

// ─── URL Validation ────────────────────────────────────────────────────────────

/** Detects if URL contains /images/ path suffix (users should only input base URL) */
const IMAGE_PATH_REGEX = /\/v1\/images\/(generations|edits)\/?$/i;
const TRAILING_V1_REGEX = /\/v1\/?$/i;

export function validateBaseUrl(url: string): { valid: boolean; warning?: string; cleaned?: string } {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, warning: 'URL cannot be empty' };

  if (IMAGE_PATH_REGEX.test(trimmed)) {
    const cleaned = trimmed.replace(/\/v1\/images\/(generations|edits)\/?$/i, '');
    return {
      valid: false,
      warning: 'Please enter the base URL only (without /v1/images/... path). Auto-corrected.',
      cleaned,
    };
  }

  if (TRAILING_V1_REGEX.test(trimmed)) {
    const cleaned = trimmed.replace(/\/v1\/?$/i, '');
    return {
      valid: false,
      warning: 'Please enter the base URL without /v1 suffix. Auto-corrected.',
      cleaned,
    };
  }

  // Remove trailing slash
  const cleaned = trimmed.replace(/\/+$/, '');

  try {
    new URL(cleaned);
    return { valid: true, cleaned };
  } catch {
    return { valid: false, warning: 'Invalid URL format' };
  }
}

// ─── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_ENDPOINTS: AIEndpoint[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    apiKey: '',
    provider: 'openai',
    modelByKind: { image: 'gpt-image-1' },
  },
];


