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
 * Provider: xAI Grok.
 *
 * Text and vision follow the OpenAI dialect, but images go through xAI's own
 * "Imagine" API, which nests the prompt in an object rather than using OpenAI's
 * flat body:
 *
 *   { model, prompt: { text, images?: [dataUri, …] } }
 *
 * Editing is the same endpoint with reference images attached (up to 5), so
 * Generate and Edit differ only by that array — a good example of why provider
 * behaviour belongs in one cohesive file instead of a shared protocol.
 *
 * Generate → POST /v1/images/generations  (Imagine body shape)
 * Edit     → same endpoint + prompt.images
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
import { joinUrl, postJsonForImage, blobToDataUrl } from '../transport';
import {
  chatCompletionsForText,
  chatCompletionsForDescribe,
  fetchStandardModels,
} from '../openai-compat';

const NAME = 'xAI Grok';

/** Up to 5 reference images per request (xAI Imagine limit). */
const MAX_REFERENCE_IMAGES = 5;

function imageModel(endpoint: AIEndpoint): string {
  return endpoint.modelByKind?.image || endpoint.modelByKind?.multi || '';
}

/** Builds the Imagine request body: prompt is an object, not a bare string. */
async function imagineBody(
  endpoint: AIEndpoint,
  prompt: string,
  images: Blob[] = [],
): Promise<Record<string, unknown>> {
  const promptObj: Record<string, unknown> = { text: prompt };
  if (images.length > 0) {
    const refs: string[] = [];
    for (const img of images.slice(0, MAX_REFERENCE_IMAGES)) {
      refs.push(await blobToDataUrl(img));
    }
    promptObj.images = refs;
  }
  return { model: imageModel(endpoint), prompt: promptObj, n: 1 };
}

export const xaiProvider: ProviderDefinition = {
  key: 'xai',
  displayName: 'xAI Grok',
  description: 'xAI API key. Grok Imagine image generation and editing, plus Grok text and vision models.',
  defaultBaseUrl: 'https://api.x.ai',
  capabilities: { generate: true, edit: true, describe: true, chat: true },
  // Imagine takes aspect ratio / resolution rather than a WxH size string,
  // and exposes no negative prompt or seed.
  features: { multiImage: true, size: false, negativePrompt: false, seed: false, mask: false },

  async generate(endpoint: AIEndpoint, req: ImageGenRequest): Promise<Blob> {
    return postJsonForImage({
      endpoint,
      providerName: NAME,
      action: 'Image generation',
      targetUrl: joinUrl(endpoint.baseUrl, '/v1/images/generations'),
      body: await imagineBody(endpoint, req.prompt),
    });
  },

  async edit(endpoint: AIEndpoint, req: ImageEditRequest): Promise<Blob> {
    return postJsonForImage({
      endpoint,
      providerName: NAME,
      action: 'Image editing',
      targetUrl: joinUrl(endpoint.baseUrl, '/v1/images/generations'),
      body: await imagineBody(endpoint, req.prompt || 'Edit this image.', req.images),
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
