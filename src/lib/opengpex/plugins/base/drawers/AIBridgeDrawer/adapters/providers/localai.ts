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
 * Provider: LocalAI (and FLUX/stable-diffusion style self-hosted gateways).
 *
 * LocalAI keeps everything image-related on /v1/images/generations; editing is
 * the same call with reference images attached (FLUX.2 multi-reference editing).
 * It does not implement /v1/images/edits.
 *
 * Generate → POST /v1/images/generations (JSON)
 * Edit     → POST /v1/images/generations (JSON + ref_images)
 * Describe → POST /v1/chat/completions (image part + instruction)
 * Chat     → POST /v1/chat/completions
 *
 * Model discovery prefers /v1/models/capabilities, a LocalAI extension that
 * reports real input/output modalities, and falls back to /v1/models.
 */

import type {
  AIEndpoint,
  AIModelInfo,
  ChatMessage,
  ImageEditRequest,
  ImageGenRequest,
  ProviderDefinition,
} from '../types';
import { joinUrl, proxyFetch, postJsonForImage, blobToBase64, readModelRecords } from '../transport';
import {
  chatCompletionsForText,
  chatCompletionsForDescribe,
  fetchStandardModels,
} from '../openai-compat';
import { resolveModality, type ModelCapabilityHints } from '../../modality';

const NAME = 'LocalAI';

function imageModel(endpoint: AIEndpoint): string {
  return endpoint.modelByKind?.image || endpoint.modelByKind?.multi || '';
}

/** stablediffusion-ggml convention: "positive | negative" inside the prompt. */
function withNegative(prompt: string, negative?: string): string {
  return negative ? `${prompt} | ${negative}` : prompt;
}

function baseBody(endpoint: AIEndpoint, req: ImageGenRequest | ImageEditRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: imageModel(endpoint),
    prompt: withNegative(req.prompt, req.negativePrompt),
    n: 1,
    size: req.size || '1024x1024',
  };
  if (req.seed !== undefined && req.seed >= 0) body.seed = req.seed;
  return body;
}

export const localaiProvider: ProviderDefinition = {
  key: 'localai',
  displayName: 'LocalAI (self-hosted)',
  description: 'LocalAI, FLUX or stable-diffusion style servers. Editing works by sending reference images to the generations endpoint.',
  defaultBaseUrl: '',
  capabilities: { generate: true, edit: true, describe: true, chat: true },
  features: { negativePrompt: true, multiImage: true, size: true, seed: true, mask: false },

  async generate(endpoint: AIEndpoint, req: ImageGenRequest): Promise<Blob> {
    return postJsonForImage({
      endpoint,
      providerName: NAME,
      action: 'Image generation',
      targetUrl: joinUrl(endpoint.baseUrl, '/v1/images/generations'),
      body: baseBody(endpoint, req),
    });
  },

  async edit(endpoint: AIEndpoint, req: ImageEditRequest): Promise<Blob> {
    const refImages: string[] = [];
    for (const img of req.images) {
      refImages.push(await blobToBase64(img));
    }
    return postJsonForImage({
      endpoint,
      providerName: NAME,
      action: 'Image editing',
      targetUrl: joinUrl(endpoint.baseUrl, '/v1/images/generations'),
      body: { ...baseBody(endpoint, req), ref_images: refImages },
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

  /**
   * Tries the capabilities extension first — it reports genuine modalities
   * instead of relying on name guessing — then falls back to /v1/models.
   */
  async fetchModels(endpoint: AIEndpoint): Promise<AIModelInfo[]> {
    try {
      const res = await proxyFetch({
        targetUrl: joinUrl(endpoint.baseUrl, '/v1/models/capabilities'),
        apiKey: endpoint.apiKey,
        method: 'GET',
      });
      if (res.ok) {
        const records = readModelRecords(await res.json());
        if (records.length > 0) {
          return records.map(m => {
            const id = String(m.id || m.name || '');
            return {
              id,
              owned_by: typeof m.owned_by === 'string' ? m.owned_by : undefined,
              modality: resolveModality(id, m as ModelCapabilityHints),
            };
          });
        }
      }
    } catch {
      // Not available on this server — fall through to the standard listing
    }
    return fetchStandardModels(endpoint, NAME);
  },
};
