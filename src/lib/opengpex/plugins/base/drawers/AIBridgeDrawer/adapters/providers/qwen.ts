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
 * Provider: Qwen / Aliyun DashScope (OpenAI-compatible mode).
 *
 * Like Gemini, images are produced through chat messages, but DashScope accepts
 * two extension fields OpenAI does not: `negative_prompt` and `seed`. If a
 * particular model rejects them, the shared JSON helper strips the offending
 * field and retries once.
 *
 * Generate → POST /v1/chat/completions (text part, + extensions)
 * Edit     → POST /v1/chat/completions (image parts + text part, + extensions)
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
import {
  buildUserMessage,
  chatCompletionsForImage,
  chatCompletionsForText,
  chatCompletionsForDescribe,
  fetchStandardModels,
} from '../openai-compat';

const NAME = 'Qwen (DashScope)';

function imageModel(endpoint: AIEndpoint): string {
  return endpoint.modelByKind?.image || endpoint.modelByKind?.multi || '';
}

/** DashScope's top-level extension fields for image generation. */
function extensions(req: { negativePrompt?: string; seed?: number }): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (req.negativePrompt) extra.negative_prompt = req.negativePrompt;
  if (req.seed !== undefined && req.seed >= 0) extra.seed = req.seed;
  return extra;
}

export const qwenProvider: ProviderDefinition = {
  key: 'qwen',
  displayName: 'Qwen (Aliyun DashScope)',
  description: 'Aliyun DashScope key. Qwen text, vision and image models; supports negative prompt and seed.',
  defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode',
  capabilities: { generate: true, edit: true, describe: true, chat: true },
  features: { negativePrompt: true, multiImage: true, size: false, seed: true, mask: false },

  async generate(endpoint: AIEndpoint, req: ImageGenRequest): Promise<Blob> {
    const message = await buildUserMessage(req.prompt);
    return chatCompletionsForImage({
      endpoint,
      providerName: NAME,
      action: 'Image generation',
      model: imageModel(endpoint),
      messages: [message],
      extra: extensions(req),
    });
  },

  async edit(endpoint: AIEndpoint, req: ImageEditRequest): Promise<Blob> {
    const message = await buildUserMessage(req.prompt || 'Edit this image.', req.images);
    return chatCompletionsForImage({
      endpoint,
      providerName: NAME,
      action: 'Image editing',
      model: imageModel(endpoint),
      messages: [message],
      extra: extensions(req),
    });
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
