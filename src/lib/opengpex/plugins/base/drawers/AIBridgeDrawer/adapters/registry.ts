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
 * Provider registry — the single list the UI and commands read from.
 *
 * To add support for a new service:
 *   1. create ./providers/<name>.ts exporting a ProviderDefinition
 *   2. add it to PROVIDER_REGISTRY below
 *   3. (optional) extend ../modality.ts if it introduces new naming patterns
 *
 * Nothing else needs to change.
 */

import type { AIEndpoint, ProviderDefinition } from './types';
import { openaiProvider } from './providers/openai';
import { anthropicProvider } from './providers/anthropic';
import { geminiProvider } from './providers/gemini';
import { xaiProvider } from './providers/xai';
import { qwenProvider } from './providers/qwen';
import { localaiProvider } from './providers/localai';
import { ollamaProvider } from './providers/ollama';

/**
 * Order determines the provider dropdown order: hosted services first (roughly
 * by how widely used they are), self-hosted options last.
 *
 * Note that not every provider can do every task — Anthropic and Ollama have no
 * image generation API at all. That is declared in `capabilities` and the UI
 * disables the corresponding tabs, so the limitation is visible before the user
 * spends a request finding out.
 */
export const PROVIDER_REGISTRY: ProviderDefinition[] = [
  // Hosted
  openaiProvider,
  anthropicProvider,
  geminiProvider,
  xaiProvider,
  qwenProvider,
  // Self-hosted
  localaiProvider,
  ollamaProvider,
];

/** Provider used when an endpoint references an unknown key. */
export const DEFAULT_PROVIDER_KEY = openaiProvider.key;

export function getProvider(key: string | undefined): ProviderDefinition | undefined {
  if (!key) return undefined;
  return PROVIDER_REGISTRY.find(p => p.key === key);
}

/**
 * Resolves the adapter for an endpoint. Falls back to the default provider so a
 * stale config can never make the drawer unusable — the user still gets a real
 * server error they can act on.
 */
export function getAdapter(endpoint: AIEndpoint | undefined): ProviderDefinition {
  return getProvider(endpoint?.provider) || openaiProvider;
}

export type { ProviderDefinition };
