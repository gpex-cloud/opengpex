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
 * Provider: Ollama — the other common self-hosted option, alongside LocalAI.
 *
 * Ollama's OpenAI-compatibility layer covers chat, vision and embeddings, but
 * it has NO image generation endpoint (it serves language models, not diffusion
 * models). So Generate and Edit are declared unsupported; users wanting local
 * image generation should pick LocalAI instead.
 *
 * Its vision support is genuinely useful for Describe: pull a vision model
 * (`ollama pull qwen3-vl:8b`) and images can be sent as base64 content parts.
 *
 * Describe → POST /v1/chat/completions (image part + instruction)
 * Chat     → POST /v1/chat/completions
 *
 * The API key is ignored by Ollama but the field is still sent, which is
 * harmless and keeps reverse-proxied setups working.
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

const NAME = 'Ollama';

export const ollamaProvider: ProviderDefinition = {
  key: 'ollama',
  displayName: 'Ollama (self-hosted)',
  description: 'Local Ollama server. Vision and chat models for Describe — no image generation (use LocalAI for that).',
  defaultBaseUrl: 'http://localhost:11434',
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
