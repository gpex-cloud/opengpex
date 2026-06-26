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
 * Defines type contracts, constants, and default configurations for AI Bridge plugin.
 * Supports multiple modes (Generate / Edit / Variations) and dynamic model selection.
 */

export const PLUGIN_ID = 'drawers.ai_bridge';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Command IDs ───────────────────────────────────────────────────────────────

export const CMD_GENERATE = 'cmd.generate';
export const CMD_OPEN_SETTINGS = 'cmd.open_settings';
export const CMD_FETCH_MODELS = 'cmd.fetch_models';

/**
 * @deprecated Use PluginService.isBusy() instead.
 * Kept for backward compatibility with any external consumers.
 */
export const SIGNAL_IS_GENERATING = 'signal.is_generating';
/** @deprecated Use PluginService.isBusy() instead. */
export const AI_BRIDGE_SIGNAL_IS_GENERATING = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_IS_GENERATING}`;

// ─── AI Mode ───────────────────────────────────────────────────────────────────

export type AIMode = 'generate' | 'edit' | 'variations';

export const AI_MODE_META: Record<AIMode, { label: string; endpoint: string }> = {
  generate: { label: 'Generate', endpoint: '/v1/images/generations' },
  edit: { label: 'Edit', endpoint: '/v1/images/edits' },
  variations: { label: 'Vary', endpoint: '/v1/images/variations' },
};

// ─── Provider Definition ───────────────────────────────────────────────────────

export interface AIProvider {
  id: string;
  name: string;
  /** Base URL (excluding /v1/images/xxx suffix, like https://api.openai.com) */
  baseUrl: string;
  apiKey: string;
  /** Currently selected model ID */
  model?: string;
}

// ─── Model Info (retrieved from /v1/models) ──────────────────────────────────────────

export interface AIModelInfo {
  id: string;
  owned_by?: string;
}

// ─── Plugin Config (persisted via pluginConfig) ────────────────────────────────

export interface AIBridgeConfig {
  providers: AIProvider[];
  activeProviderId: string;
  /** Current AI mode */
  mode: AIMode;
  prompt: string;
  negativePrompt: string;
  /** -1 means random each time */
  seed: number;
  /** Uses local canvas mock instead of real API */
  isMockMode: boolean;
  /** Image size preset */
  size: 'auto' | '512x512' | '1024x1024' | '1024x1536' | '1536x1024' | '1024x1792' | '1792x1024';
  /** Strength for Edit/Variations mode (0-1) */
  strength: number;
  /** Cached list of available models (indexed by provider ID) */
  cachedModels: Record<string, AIModelInfo[]>;
}

// ─── Generation History Record ─────────────────────────────────────────────────

export interface GenerationRecord {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  mode: AIMode;
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
const IMAGE_PATH_REGEX = /\/v1\/images\/(generations|edits|variations)\/?$/i;
const TRAILING_V1_REGEX = /\/v1\/?$/i;

export function validateBaseUrl(url: string): { valid: boolean; warning?: string; cleaned?: string } {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, warning: 'URL cannot be empty' };

  if (IMAGE_PATH_REGEX.test(trimmed)) {
    const cleaned = trimmed.replace(/\/v1\/images\/(generations|edits|variations)\/?$/i, '');
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

export const DEFAULT_PROVIDERS: AIProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    apiKey: '',
  },
];
