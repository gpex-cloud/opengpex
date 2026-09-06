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
 * Provider: OpenAI (and API-identical services — Azure OpenAI, LiteLLM
 * passthrough, most "OpenAI-compatible" gateways).
 *
 * Generate → POST /v1/images/generations (JSON)
 * Edit     → POST /v1/images/edits (multipart)
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
import { joinUrl, proxyFetch, throwRequestError, postJsonForImage, extractImageFromResponse } from '../transport';
import {
  chatCompletionsForText,
  chatCompletionsForDescribe,
  fetchStandardModels,
} from '../openai-compat';

const NAME = 'OpenAI';

function imageModel(endpoint: AIEndpoint): string {
  return endpoint.modelByKind?.image || '';
}

/** gpt-image-* has its own parameter rules (see generate below). */
function isGptImage(model: string): boolean {
  return /^gpt-image/i.test(model);
}

/** First-party OpenAI models reject the seed / negative_prompt extensions. */
function isFirstPartyModel(model: string): boolean {
  return /^(dall-e|gpt-image)/i.test(model);
}

export const openaiProvider: ProviderDefinition = {
  key: 'openai',
  displayName: 'OpenAI',
  description: 'OpenAI and API-identical services (Azure OpenAI, LiteLLM, most OpenAI-compatible gateways). Images via /v1/images.',
  defaultBaseUrl: 'https://api.openai.com',
  capabilities: { generate: true, edit: true, describe: true, chat: true },
  features: { mask: true, negativePrompt: false, size: true, seed: false, multiImage: false },

  async generate(endpoint: AIEndpoint, req: ImageGenRequest): Promise<Blob> {
    const model = imageModel(endpoint);
    const gptImage = isGptImage(model);

    const body: Record<string, unknown> = {
      prompt: req.prompt,
      n: 1,
      size: req.size || '1024x1024',
      response_format: 'b64_json',
    };
    if (model) body.model = model;

    // gpt-image-* rejects response_format (it always returns b64)
    if (gptImage) delete body.response_format;

    // 'auto' size is only understood by gpt-image-*
    if (body.size === 'auto' && !gptImage) body.size = '1024x1024';

    // Extensions are only accepted by non-first-party models behind an
    // OpenAI-shaped gateway (SD WebUI, ComfyUI bridges, …)
    if (!isFirstPartyModel(model)) {
      if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
      if (req.seed !== undefined && req.seed >= 0) body.seed = req.seed;
    }

    // litellm/Azure workaround: gpt-image-1 requests routed through litellm can
    // fail with "Attempted to access streaming request content, without having
    // called read()" because the handler mistakes them for streaming requests.
    if (gptImage) body.stream = false;

    return postJsonForImage({
      endpoint,
      providerName: NAME,
      action: 'Image generation',
      targetUrl: joinUrl(endpoint.baseUrl, '/v1/images/generations'),
      body,
    });
  },

  async edit(endpoint: AIEndpoint, req: ImageEditRequest): Promise<Blob> {
    const model = imageModel(endpoint);
    const targetUrl = joinUrl(endpoint.baseUrl, '/v1/images/edits');

    const formData = new FormData();
    formData.append('image', req.images[0], 'source.png');
    formData.append('prompt', req.prompt || '');
    formData.append('n', '1');
    const size = req.size === 'auto' && !isGptImage(model) ? '1024x1024' : (req.size || '1024x1024');
    formData.append('size', size);
    formData.append('response_format', 'b64_json');
    if (model) formData.append('model', model);

    const res = await proxyFetch({
      targetUrl,
      apiKey: endpoint.apiKey,
      method: 'POST',
      body: formData,
      // No contentType: the browser sets the multipart boundary
    });

    // Multipart bodies are not worth rebuilding for parameter self-healing
    if (!res.ok) await throwRequestError(res, { endpoint, providerName: NAME, action: 'Image editing' });
    return extractImageFromResponse(res, endpoint.apiKey);
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
