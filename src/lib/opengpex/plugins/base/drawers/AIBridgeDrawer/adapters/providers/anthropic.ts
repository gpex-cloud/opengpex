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
 * Provider: Anthropic Claude — vision and chat only.
 *
 * Claude has NO image generation API of any kind, so Generate and Edit are
 * declared unsupported and their tabs are disabled. What it is very good at is
 * looking at an image and writing about it, which is exactly the Describe task.
 *
 * Uses Anthropic's official OpenAI-compatibility layer at `/v1/`, which accepts
 * standard `/v1/chat/completions` requests including image content parts.
 * Note: that layer ignores unsupported fields silently rather than erroring.
 *
 * Describe → POST /v1/chat/completions (image part + instruction)
 * Chat     → POST /v1/chat/completions
 */

import type {
  AIEndpoint,
  AIModelInfo,
  ChatMessage,
  ImageEditRequest,
  ImageGenRequest,
  ProviderDefinition,
} from '../types';
import { unsupportedTask } from '../types';
import {
  chatCompletionsForText,
  chatCompletionsForDescribe,
  fetchStandardModels,
} from '../openai-compat';

const NAME = 'Anthropic Claude';

export const anthropicProvider: ProviderDefinition = {
  key: 'anthropic',
  displayName: 'Anthropic Claude',
  description: 'Claude API key. Reads images and writes prompts (Describe) — Claude has no image generation API.',
  defaultBaseUrl: 'https://api.anthropic.com',
  capabilities: { generate: false, edit: false, describe: true, chat: true },
  features: {},

  async generate(_endpoint: AIEndpoint, _req: ImageGenRequest): Promise<Blob> {
    throw unsupportedTask(NAME, 'image generation');
  },

  async edit(_endpoint: AIEndpoint, _req: ImageEditRequest): Promise<Blob> {
    throw unsupportedTask(NAME, 'image editing');
  },

  async describe(endpoint: AIEndpoint, image: Blob, instruction: string): Promise<string> {
    const model = endpoint.modelByKind?.multi || endpoint.modelByKind?.text || '';
    return chatCompletionsForDescribe(endpoint, NAME, model, image, instruction);
  },

  async chat(endpoint: AIEndpoint, messages: ChatMessage[]): Promise<string> {
    const model = endpoint.modelByKind?.text || endpoint.modelByKind?.multi || '';
    return chatCompletionsForText(endpoint, NAME, model, messages);
  },

  async fetchModels(endpoint: AIEndpoint): Promise<AIModelInfo[]> {
    return fetchStandardModels(endpoint, NAME);
  },
};
