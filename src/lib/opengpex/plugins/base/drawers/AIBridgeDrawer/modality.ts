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
 * Model modality classification — deliberately decoupled from providers.
 *
 * Modality answers "what can this model do?" and is resolved from either
 * structured capability data (when a provider exposes it, e.g. LocalAI's
 * /v1/models/capabilities) or, as a fallback, from an exact-name lookup in
 * MODEL_MODALITY_PROPERTIES below. No pattern matching: a model either is in
 * the table or is 'unknown'.
 *
 * Modality NEVER blocks an action. It only drives the badge shown next to a
 * model name plus a soft hint — the server is the authority on what actually
 * works, so a missing/wrong entry must not stop the user from trying.
 */

/** What a model can do:
 *  - `image`  outputs images (text-to-image and image-to-image / edit)
 *  - `text`   text→text chat only
 *  - `vision` accepts images and answers in text (Describe's ideal pick)
 *  - `unknown` not in the table and no structured capability data — a legal,
 *             non-blocking state */
export type ModelModality = 'image' | 'text' | 'vision' | 'unknown';

/**
 * Exact model-ID → modality table. Full names only, one entry per model —
 * append as needed. Generic open-weight families (sd / flux / / sdxl…) are
 * deliberately absent: they are never exposed as services directly, they sit
 * behind an LLM gateway whose model IDs are what users actually see.
 */
export const MODEL_MODALITY_PROPERTIES: Record<string, ModelModality> = {
  // ── Zhipu GLM ── (newest first)
  'glm-5.3': 'text',
  'glm-5.3-flash': 'vision',
  'glm-5.3-flashx': 'vision',
  'glm-5v-turbo': 'vision',
  'glm-5.2': 'text',
  'glm-5.1': 'text',
  'glm-5.1-highspeed': 'text',
  'glm-5': 'text',
  'glm-5-turbo': 'text',
  'glm-4.7': 'text',
  'glm-4.7-flashx': 'text',
  'glm-4.7-flash': 'text',
  'glm-4.6': 'text',
  'glm-4.6v': 'vision',
  'glm-4.6v-flash': 'vision',
  'glm-4.6v-flashx': 'vision',
  'glm-4.5': 'text',
  'glm-4.5-air': 'text',
  'glm-4.1v-thinking-flash': 'vision',
  'glm-4.1v-thinking-flashx': 'vision',
  'glm-4-flash-250414': 'text',
  'glm-4-flashx-250414': 'text',
  'glm-4v-flash': 'vision',
  'codegeex-4': 'text',
  'charglm-4': 'text',
  'emohaa': 'text',

  // ── OpenAI ── (newest first)
  'gpt-6.1-sol': 'vision',
  'gpt-6-astra': 'vision',
  'gpt-6-luna': 'vision',
  'gpt-5.6': 'vision',
  'gpt-5.5': 'vision',
  'gpt-5': 'vision',
  'gpt-5-mini': 'vision',
  'gpt-5-nano': 'vision',
  'o4-mini': 'vision',
  'o3': 'vision',
  'o3-mini': 'text',
  'o3-mini-2025-01-31': 'text',
  'o1': 'vision',
  'o1-2024-12-17': 'vision',
  'o1-preview': 'text',
  'o1-mini': 'text',
  'o1-mini-2024-09-12': 'text',
  'gpt-4.5': 'vision',
  'gpt-4.5-preview': 'vision',
  'gpt-4.1': 'vision',
  'chatgpt-4o-latest': 'vision',
  'gpt-4o': 'vision',
  'gpt-4o-2024-11-20': 'vision',
  'gpt-4o-2024-08-06': 'vision',
  'gpt-4o-2024-05-13': 'vision',
  'gpt-4o-mini': 'vision',
  'gpt-4o-mini-2024-07-18': 'vision',
  'gpt-4o-realtime-preview': 'vision',
  'gpt-4-turbo': 'vision',
  'gpt-4-turbo-2024-04-09': 'vision',
  'gpt-4-turbo-preview': 'vision',
  'gpt-4-vision-preview': 'vision',
  'gpt-4-0125-preview': 'text',
  'gpt-4-1106-preview': 'text',
  'gpt-4': 'text',
  'gpt-4-32k': 'text',
  'gpt-3.5-turbo': 'text',
  'gpt-3.5-turbo-0125': 'text',
  'gpt-3.5-turbo-1106': 'text',
  'gpt-image-1': 'image',
  'dall-e-3': 'image',
  'dall-e-2': 'image',

  // ── Anthropic ── (newest first)
  'claude-fable-5-1': 'vision',
  'claude-opus-5-5': 'vision',
  'claude-sonnet-5-5': 'vision',
  'claude-haiku-5-5': 'vision',
  'claude-opus-5': 'vision',
  'claude-sonnet-5': 'vision',
  'claude-opus-4-8': 'vision',
  'claude-opus-4-7': 'vision',
  'claude-opus-4-6': 'vision',
  'claude-opus-4-5': 'vision',
  'claude-sonnet-4-7': 'vision',
  'claude-sonnet-4-6': 'vision',
  'claude-haiku-4-5': 'vision',
  'claude-opus-4-1': 'vision',
  'claude-sonnet-4-5': 'vision',
  'claude-3-7-sonnet': 'vision',
  'claude-3-7-sonnet-latest': 'vision',
  'claude-3-7-sonnet-20250219': 'vision',
  'claude-3-5-sonnet': 'vision',
  'claude-3-5-sonnet-latest': 'vision',
  'claude-3-5-sonnet-20241022': 'vision',
  'claude-3-5-sonnet-20240620': 'vision',
  'claude-3-5-haiku': 'vision',
  'claude-3-5-haiku-latest': 'vision',
  'claude-3-5-haiku-20241022': 'vision',
  'claude-3-opus': 'vision',
  'claude-3-opus-latest': 'vision',
  'claude-3-opus-20240229': 'vision',
  'claude-3-sonnet': 'vision',
  'claude-3-sonnet-20240229': 'vision',
  'claude-3-haiku': 'vision',
  'claude-3-haiku-20240307': 'vision',

  // ── Google ── (newest first)
  'gemini-3.8-flash': 'vision',
  'gemini-3.6-flash': 'vision',
  'gemini-3.5-flash-lite': 'vision',
  'gemini-3.1-pro-preview': 'vision',
  'gemini-3.1-flash-lite': 'vision',
  'gemini-3-pro-image': 'image',
  'gemini-3.1-flash-image': 'image',
  'gemini-3.1-flash-lite-image': 'image',
  'gemini-2.5-pro': 'vision',
  'gemini-2.5-flash': 'vision',
  'gemini-2.5-flash-image': 'image',
  'gemini-2.0-pro-exp': 'vision',
  'gemini-2.0-pro-exp-02-05': 'vision',
  'gemini-2.0-flash': 'vision',
  'gemini-2.0-flash-exp': 'vision',
  'gemini-2.0-flash-lite': 'vision',
  'gemini-2.0-flash-lite-preview': 'vision',
  'gemini-2.0-flash-thinking-exp': 'vision',
  'gemini-2.0-flash-thinking-exp-01-21': 'vision',
  'gemini-1.5-pro': 'vision',
  'gemini-1.5-pro-latest': 'vision',
  'gemini-1.5-flash': 'vision',
  'gemini-1.5-flash-latest': 'vision',
  'gemini-1.5-flash-8b': 'vision',
  'gemini-1.5-flash-8b-latest': 'vision',
  'gemini-pro': 'text',
  'gemini-1.0-pro': 'text',
  'gemini-pro-vision': 'vision',
  'imagen-3.0-generate-002': 'image',
  'imagen-3.0-generate-001': 'image',
  'imagen-3': 'image',

  // ── xAI ── (newest first)
  'grok-5': 'vision',
  'grok-4': 'vision',
  'grok-3': 'vision',
  'grok-3-mini': 'text',
  'grok-2-vision': 'vision',
  'grok-2-vision-1212': 'vision',
  'grok-2-vision-latest': 'vision',
  'grok-vision-beta': 'vision',
  'grok-2': 'text',
  'grok-2-1212': 'text',
  'grok-2-latest': 'text',
  'grok-beta': 'text',

  // ── Alibaba Qwen ── (newest first)
  'qwen3-max': 'text',
  'qwen3-plus': 'text',
  'qwen3-vl-max': 'vision',
  'qwen3-vl-plus': 'vision',
  'qwen2.5-max': 'text',
  'qwen2.5-plus': 'text',
  'qwen2.5-turbo': 'text',
  'qwen2.5-72b-instruct': 'text',
  'qwen2.5-32b-instruct': 'text',
  'qwen2.5-14b-instruct': 'text',
  'qwen2.5-7b-instruct': 'text',
  'qwen2.5-coder-32b-instruct': 'text',
  'qwen2.5-coder-14b-instruct': 'text',
  'qwen2.5-coder-7b-instruct': 'text',
  'qwen2.5-vl-72b-instruct': 'vision',
  'qwen2.5-vl-7b-instruct': 'vision',
  'qwen2.5-vl-3b-instruct': 'vision',
  'qwen2-vl-72b-instruct': 'vision',
  'qwen2-vl-7b-instruct': 'vision',
  'qwen2-vl-2b-instruct': 'vision',
  'qwq-32b': 'text',
  'qwq-32b-preview': 'text',
  'qwen-max': 'text',
  'qwen-max-latest': 'text',
  'qwen-plus': 'text',
  'qwen-plus-latest': 'text',
  'qwen-turbo': 'text',
  'qwen-turbo-latest': 'text',
  'qwen-long': 'text',
  'qwen-vl-max': 'vision',
  'qwen-vl-max-latest': 'vision',
  'qwen-vl-plus': 'vision',
  'qwen-vl-plus-latest': 'vision',
  'qwen-image': 'image',
  'wanx-2.1-t2i-plus': 'image',
  'wanx-2.1-t2i-turbo': 'image',
  'wanx-2.0-t2i-turbo': 'image',
  'wanx-v1': 'image',

  // ── DeepSeek ── (newest first)
  // 'deepseek-flash' is the official API ID for V4.1-Flash; version-style IDs
  // below it are what third-party gateways typically expose.
  'deepseek-v4.1-flash': 'vision',
  'deepseek-v4-pro': 'text',
  'deepseek-flash': 'vision',
  'deepseek-v4-flash': 'text',
  'deepseek-v4-flash-vision-exp': 'vision',
  'deepseek-chat': 'text',
  'deepseek-reasoner': 'text',
  'deepseek-v3': 'text',
  'deepseek-r1': 'text',
  'deepseek-coder': 'text',
  'deepseek-vl2': 'vision',
  'deepseek-vl': 'vision',

  // ── Meta Llama & Open Multimodal (Ollama / LocalAI / gateways) ──
  'llama-3.3-70b-instruct': 'text',
  'llama-3.2-90b-vision-instruct': 'vision',
  'llama-3.2-11b-vision-instruct': 'vision',
  'llama-3.2-3b-instruct': 'text',
  'llama-3.2-1b-instruct': 'text',
  'llama-3.1-405b-instruct': 'text',
  'llama-3.1-70b-instruct': 'text',
  'llama-3.1-8b-instruct': 'text',
  'llama-3-70b-instruct': 'text',
  'llama-3-8b-instruct': 'text',
  'llava': 'vision',
  'llava-v1.6-34b': 'vision',
  'llava-1.5-13b': 'vision',
  'llava-1.5-7b': 'vision',
  'bakllava': 'vision',

  // ── Other Providers: Moonshot Kimi, ByteDance Doubao, MiniMax ── (newest first)
  'kimi-k3': 'text',
  'kimi-k2-thinking': 'text',
  'kimi-k2': 'text',
  'kimi-k1.5': 'vision',
  'moonshot-v1-128k': 'text',
  'moonshot-v1-32k': 'text',
  'moonshot-v1-8k': 'text',
  'minimax-m3': 'vision',
  'minimax-m2.7': 'text',
  'minimax-text-01': 'text',
  'doubao-pro-128k': 'text',
  'doubao-pro-32k': 'text',
  'doubao-vision-pro-32k': 'vision',
  'doubao-seed-2.0-pro': 'vision',
  'doubao-seed-2.0-lite': 'vision',
  'doubao-seed-2.0-mini': 'vision',
  'doubao-seed-2.0-code': 'text',
};

/**
 * Exact-name lookup: the whole entry or nothing.
 */
export function inferModality(modelId: string): ModelModality {
  return MODEL_MODALITY_PROPERTIES[modelId.toLowerCase()] ?? 'unknown';
}

/** Structured capability payload some providers expose (LocalAI-style). */
export interface ModelCapabilityHints {
  /** e.g. ['chat', 'vision'] / ['image'] */
  capabilities?: string[];
  /** e.g. ['text', 'image'] */
  input_modalities?: string[];
  /** e.g. ['image'] / ['text'] */
  output_modalities?: string[];
}

/**
 * Resolves modality from structured capability data when available.
 * Returns 'unknown' if the payload carries nothing usable, so callers can fall
 * back to `inferModality(id)`.
 */
export function modalityFromCapabilities(caps: ModelCapabilityHints | undefined): ModelModality {
  if (!caps) return 'unknown';
  const outputs = caps.output_modalities || [];
  const inputs = caps.input_modalities || [];
  const abilities = (caps.capabilities || []).map(c => c.toLowerCase());

  const outputsImage = outputs.includes('image');
  const outputsText = outputs.includes('text');
  const acceptsImage = inputs.includes('image') || abilities.includes('vision');

  // Outputs images AND understands them / talks → genuinely multi-purpose
  if (outputsImage && acceptsImage) return 'vision';
  if (outputsImage) return 'image';
  // Understands images but answers in text → vision model (Describe's ideal pick)
  if (acceptsImage && outputsText) return 'vision';
  if (outputsText) return 'text';

  // No modality arrays: fall back to the coarse capability list
  if (abilities.includes('image')) return 'image';
  if (abilities.includes('vision')) return 'vision';
  if (abilities.includes('chat')) return 'text';
  return 'unknown';
}

/**
 * Best-effort modality: structured capabilities first, exact-name table second.
 */
export function resolveModality(modelId: string, caps?: ModelCapabilityHints): ModelModality {
  const fromCaps = modalityFromCapabilities(caps);
  return fromCaps !== 'unknown' ? fromCaps : inferModality(modelId);
}

// ─── Task suitability (advisory only — never disables anything) ────────────────

/** Modalities that plausibly produce an image (Generate / Edit). */
export function canProduceImage(modality: ModelModality): boolean {
  return modality === 'image' || modality === 'unknown';
}

/** Modalities that plausibly read an image and answer in text (Describe). */
export function canReadImage(modality: ModelModality): boolean {
  return modality === 'vision' || modality === 'unknown';
}

/** Soft warning for the current selection, or null when it looks fine.
 *  Shown as a hint next to the action button — the button stays clickable. */
export function modalityWarning(
  modality: ModelModality,
  task: 'image' | 'describe',
): string | null {
  if (task === 'image') {
    if (modality === 'text') return 'This looks like a text-only model — generation may fail.';
    return null;
  }
  if (modality === 'image') return 'This looks like an image-only model — it probably cannot describe.';
  if (modality === 'text') return 'This model may not accept images — Describe may fail.';
  return null;
}
