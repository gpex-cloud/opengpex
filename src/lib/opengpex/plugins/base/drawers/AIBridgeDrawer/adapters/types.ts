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
 * Provider adapter contracts — types only, no implementation.
 *
 * An *endpoint* is what the user configured: a base URL + API key, plus the
 * name of the provider it belongs to. A *provider* is a code-defined unit that
 * knows exactly how to talk to that service — one file per provider, fully
 * self-contained. There is no protocol guessing and no cross-provider retry:
 * the provider chosen at configuration time is the provider used at runtime.
 *
 * Sibling files: transport.ts (HTTP plumbing), openai-compat.ts (shared dialect
 * building blocks), registry.ts (the provider list + lookup).
 */

import type { ModelModality } from '../modality';

// ─── Endpoint (user configuration, persisted) ──────────────────────────────────

/** A configured access point: the credentials the user bought from a provider. */
export interface AIEndpoint {
  id: string;
  /** User-editable label (defaults to the provider's display name) */
  name: string;
  /** Base URL without the /v1/... suffix, e.g. https://api.openai.com */
  baseUrl: string;
  apiKey: string;
  /** Which provider's rules to follow — chosen from a dropdown, never guessed */
  provider: string;
  /** Last-used model per task kind */
  modelByKind?: {
    image?: string;
    text?: string;
    multi?: string;
  };
}

// ─── Model info ────────────────────────────────────────────────────────────────

export interface AIModelInfo {
  id: string;
  owned_by?: string;
  modality?: ModelModality;
}

// ─── Provider capability switches (drive UI visibility) ────────────────────────

/**
 * Which tasks a provider can perform at all.
 *
 * This is a hard, code-authored fact — not an inference. Some services simply
 * have no image generation API (Anthropic, Ollama), so the corresponding tabs
 * are disabled rather than failing at request time. Contrast with ModelModality,
 * which IS inferred and therefore only ever advisory.
 */
export interface ProviderCapabilities {
  /** text → image */
  generate: boolean;
  /** image(s) + prompt → image */
  edit: boolean;
  /** image → text (vision) */
  describe: boolean;
  /** text → text */
  chat: boolean;
}

export interface ProviderFeatures {
  /** negative prompt supported */
  negativePrompt?: boolean;
  /** multiple input images supported */
  multiImage?: boolean;
  /** inpainting mask supported (no mask source in the product yet — reserved) */
  mask?: boolean;
  /** size parameter supported */
  size?: boolean;
  seed?: boolean;
}

// ─── Normalized request shapes ─────────────────────────────────────────────────

export interface ImageGenRequest {
  prompt: string;
  negativePrompt?: string;
  size: string;
  seed?: number;
}

export interface ImageEditRequest {
  images: Blob[];
  prompt: string;
  negativePrompt?: string;
  size: string;
  seed?: number;
}

export interface ChatMessage {
  role: string;
  content: string;
}

// ─── Provider definition (one per file, registered in registry.ts) ─────────────

/**
 * Everything the app needs to know about a provider, in one cohesive object.
 * Adding support for a new service = create one file exporting this, then add
 * it to PROVIDER_REGISTRY. No other file needs to change.
 */
export interface ProviderDefinition {
  /** Stable key persisted in AIEndpoint.provider */
  key: string;
  displayName: string;
  /** One-line explanation shown in the provider dropdown */
  description: string;
  /** Pre-filled when the user picks this provider ('' = user must supply) */
  defaultBaseUrl: string;
  /** Which tasks this service supports at all (hard fact, drives tab enabling) */
  capabilities: ProviderCapabilities;
  features: ProviderFeatures;

  /** Text → image. Throws if capabilities.generate is false. */
  generate(endpoint: AIEndpoint, req: ImageGenRequest): Promise<Blob>;
  /** Image(s) + prompt → image. Throws if capabilities.edit is false. */
  edit(endpoint: AIEndpoint, req: ImageEditRequest): Promise<Blob>;
  /** Image → text prompt (vision) */
  describe(endpoint: AIEndpoint, image: Blob, instruction: string): Promise<string>;
  /** Text → text */
  chat(endpoint: AIEndpoint, messages: ChatMessage[]): Promise<string>;
  /** Model discovery; annotates modality using whatever the service exposes */
  fetchModels(endpoint: AIEndpoint): Promise<AIModelInfo[]>;
}

/** Standard rejection for a task the provider does not offer. */
export function unsupportedTask(providerName: string, task: string): Error {
  return new Error(
    `${providerName} does not offer ${task}. ` +
    `Switch this endpoint to a provider that does, or use a different endpoint.`,
  );
}
