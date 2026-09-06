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
 * Reusable building blocks for the OpenAI-compatible API dialect.
 *
 * A large part of the ecosystem speaks the same `/v1/chat/completions` and
 * `/v1/models` shapes, so these functions are the pieces provider adapters
 * assemble instead of copy-pasting:
 *
 *   buildUserMessage           text + optional image parts → one user message
 *   chatCompletionsForImage    chat call that is expected to return an image
 *   chatCompletionsForText     plain text chat
 *   chatCompletionsForDescribe vision call: image + instruction → text
 *   fetchStandardModels        GET /v1/models with name-based modality tagging
 *
 * This is composition, not inheritance: each provider file stays readable on its
 * own and layers its own quirks on top (e.g. Qwen adds negative_prompt / seed).
 */

import type { AIEndpoint, AIModelInfo, ChatMessage } from './types';
import {
  joinUrl,
  proxyFetch,
  blobToDataUrl,
  throwRequestError,
  postJsonForImage,
  extractTextFromResponse,
  readModelRecords,
  readErrorInfo,
  endpointMismatchMessage,
} from './transport';
import { inferModality } from '../modality';

// ─── Multimodal message parts ──────────────────────────────────────────────────

export interface MultimodalPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface MultimodalMessage {
  role: string;
  content: MultimodalPart[];
}

/** Builds a single user message from a prompt and optional input images. */
export async function buildUserMessage(
  prompt: string,
  images: Blob[] = [],
): Promise<MultimodalMessage> {
  const parts: MultimodalPart[] = [];
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: await blobToDataUrl(img) } });
  }
  parts.push({ type: 'text', text: prompt });
  return { role: 'user', content: parts };
}

// ─── Image generation via chat ─────────────────────────────────────────────────

export interface ChatImageOptions {
  endpoint: AIEndpoint;
  providerName: string;
  action: string;
  model: string;
  messages: MultimodalMessage[];
  /** Extra top-level body fields (provider-specific extensions) */
  extra?: Record<string, unknown>;
}

/** Requests an image through /v1/chat/completions (image-in-chat style). */
export async function chatCompletionsForImage(opts: ChatImageOptions): Promise<Blob> {
  const targetUrl = joinUrl(opts.endpoint.baseUrl, '/v1/chat/completions');
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
    ...(opts.extra || {}),
  };
  return postJsonForImage({
    endpoint: opts.endpoint,
    providerName: opts.providerName,
    action: opts.action,
    targetUrl,
    body,
  });
}

// ─── Text chat ─────────────────────────────────────────────────────────────────

/** Plain text chat completion. Returns message.content. */
export async function chatCompletionsForText(
  endpoint: AIEndpoint,
  providerName: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const targetUrl = joinUrl(endpoint.baseUrl, '/v1/chat/completions');
  const res = await proxyFetch({
    targetUrl,
    apiKey: endpoint.apiKey,
    method: 'POST',
    body: JSON.stringify({ model, messages, stream: false }),
    contentType: 'application/json',
  });
  if (!res.ok) await throwRequestError(res, { endpoint, providerName, action: 'Text chat' });
  return extractTextFromResponse(res, 'chat');
}

// ─── Describe (vision: image → text) ───────────────────────────────────────────

/** Sends one image plus an instruction and returns the assistant's text. */
export async function chatCompletionsForDescribe(
  endpoint: AIEndpoint,
  providerName: string,
  model: string,
  image: Blob,
  instruction: string,
): Promise<string> {
  if (!model) {
    throw new Error('No vision-capable model selected. Pick one in the model list first.');
  }
  const targetUrl = joinUrl(endpoint.baseUrl, '/v1/chat/completions');
  const message = await buildUserMessage(instruction, [image]);
  const res = await proxyFetch({
    targetUrl,
    apiKey: endpoint.apiKey,
    method: 'POST',
    body: JSON.stringify({ model, messages: [message], stream: false }),
    contentType: 'application/json',
  });
  if (!res.ok) await throwRequestError(res, { endpoint, providerName, action: 'Describe' });
  return extractTextFromResponse(res, 'describe');
}

// ─── Model discovery (standard /v1/models) ─────────────────────────────────────

/**
 * Standard OpenAI-compatible model listing.
 *
 * The spec only guarantees an `id` per model, so modality is annotated by name
 * pattern. Providers exposing richer capability data override fetchModels.
 */
export async function fetchStandardModels(
  endpoint: AIEndpoint,
  providerName: string,
): Promise<AIModelInfo[]> {
  const targetUrl = joinUrl(endpoint.baseUrl, '/v1/models');
  const res = await proxyFetch({ targetUrl, apiKey: endpoint.apiKey, method: 'GET' });
  if (!res.ok) {
    const info = await readErrorInfo(res);
    if (info.status === 404 || info.status === 405) {
      throw new Error(endpointMismatchMessage(endpoint, providerName, 'Model discovery', info.status));
    }
    throw new Error(info.message);
  }
  const records = readModelRecords(await res.json());
  return records.map(m => {
    const id = String(m.id || m.name || '');
    return {
      id,
      owned_by: typeof m.owned_by === 'string' ? m.owned_by : undefined,
      modality: inferModality(id),
    };
  });
}
