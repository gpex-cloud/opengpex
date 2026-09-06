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
 * Provider: Google Gemini (via its OpenAI-compatibility surface).
 *
 * Gemini has no separate image endpoint — generation and editing are the same
 * chat call, differing only by whether input images are attached.
 *
 * Generate → POST /v1/chat/completions (text part)
 * Edit     → POST /v1/chat/completions (image parts + text part)
 * Describe → POST /v1/chat/completions (image part + instruction)
 * Chat     → POST /v1/chat/completions
 *
 * Also select this provider for any gateway that mimics Gemini's image-in-chat
 * behaviour.
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

const NAME = 'Google Gemini';

function imageModel(endpoint: AIEndpoint): string {
  return endpoint.modelByKind?.image || endpoint.modelByKind?.multi || '';
}

export const geminiProvider: ProviderDefinition = {
  key: 'gemini',
  displayName: 'Google Gemini',
  description: 'Google AI Studio key, or any gateway that generates images through chat messages. No separate image endpoint.',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  capabilities: { generate: true, edit: true, describe: true, chat: true },
  features: { multiImage: true, size: false, negativePrompt: false, seed: false, mask: false },

  async generate(endpoint: AIEndpoint, req: ImageGenRequest): Promise<Blob> {
    const message = await buildUserMessage(req.prompt);
    return chatCompletionsForImage({
      endpoint,
      providerName: NAME,
      action: 'Image generation',
      model: imageModel(endpoint),
      messages: [message],
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
