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

import type { AIEndpoint, AIModelInfo, ChatMessage, AgentToolDef, AgentToolCall, AgentMessage } from './types';
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
import { streamAnthropicMessagesForAgent } from './anthropic-agent';

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

// ─── Agent chat (non-streaming) ─────────────────────────────────────────────────

export interface AgentChatOptions {
  endpoint: AIEndpoint;
  providerName: string;
  model: string;
  messages: AgentMessage[];
  tools?: AgentToolDef[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  signal?: AbortSignal;
}

export interface AgentChatResult {
  content: string | null;
  tool_calls: AgentToolCall[];
  finish_reason: string;
}

/**
 * Chat completion with tool calling support (non-streaming).
 *
 * Returns the full structured assistant response instead of just a string.
 * Calling path: AgentDef → resolve endpoint → chatCompletionsForAgent()
 * (bypasses ProviderDefinition.chat(), calls openai-compat directly)
 */
export async function chatCompletionsForAgent(
  opts: AgentChatOptions,
): Promise<AgentChatResult> {
  const targetUrl = joinUrl(opts.endpoint.baseUrl, '/v1/chat/completions');
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.tool_choice ?? 'auto';
  }
  const res = await proxyFetch({
    targetUrl,
    apiKey: opts.endpoint.apiKey,
    method: 'POST',
    body: JSON.stringify(body),
    contentType: 'application/json',
    signal: opts.signal,
  });
  if (!res.ok) {
    await throwRequestError(res, {
      endpoint: opts.endpoint,
      providerName: opts.providerName,
      action: 'Agent chat',
    });
  }
  const json = await res.json();
  const choice = json.choices?.[0];
  const message = choice?.message ?? {};
  return {
    content: message.content ?? null,
    tool_calls: message.tool_calls ?? [],
    finish_reason: choice?.finish_reason ?? 'stop',
  };
}

// ─── Agent chat (SSE streaming) ─────────────────────────────────────────────────

export interface StreamAgentChatCallbacks {
  /** Called for each text token as it arrives. */
  onToken: (token: string) => void;
  /** Called once when the stream finishes (includes accumulated tool_calls). */
  onComplete: (result: AgentChatResult) => void;
  /** Called on non-abort errors. */
  onError: (error: Error) => void;
}

/**
 * Streaming chat completion with tool calling support.
 *
 * Fires `onToken` per text delta for typewriter effect, then `onComplete` with
 * the fully assembled result (including any tool_calls).
 * Returns an AbortController — call `.abort()` to cancel mid-stream.
 */
export function streamChatCompletionsForAgent(
  opts: AgentChatOptions,
  callbacks: StreamAgentChatCallbacks,
): AbortController {
  // Anthropic Claude: use the NATIVE Messages API, not this OpenAI-compat
  // path. The OpenAI-compat shim mangles tool_use/tool_result pairing and
  // returns a 400. See adapters/anthropic-agent.ts.
  if (opts.providerName === 'anthropic') {
    return streamAnthropicMessagesForAgent(opts, callbacks);
  }

  const controller = new AbortController();

  // Merge external signal with our own controller
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;

  (async () => {
    try {
      const targetUrl = joinUrl(opts.endpoint.baseUrl, '/v1/chat/completions');
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: opts.messages,
        stream: true,
      };
      if (opts.tools?.length) {
        body.tools = opts.tools;
        body.tool_choice = opts.tool_choice ?? 'auto';
      }

      const res = await proxyFetch({
        targetUrl,
        apiKey: opts.endpoint.apiKey,
        method: 'POST',
        body: JSON.stringify(body),
        contentType: 'application/json',
        signal,
      });

      if (!res.ok) {
        const info = await readErrorInfo(res);
        throw new Error(`Agent chat failed (${info.status}): ${info.message}`);
      }
      if (!res.body) {
        throw new Error('Response body is null — streaming not supported by proxy');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      const toolCalls: AgentToolCall[] = [];
      let finishReason = 'stop';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';  // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;  // skip malformed chunks
          }

          const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
          const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;

          if (delta?.content) {
            const token = delta.content as string;
            content += token;
            callbacks.onToken(token);
          }

          // Accumulate tool_calls deltas (OpenAI streams them incrementally)
          if (delta?.tool_calls) {
            const deltaToolCalls = delta.tool_calls as Array<{
              index: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
            for (const dtc of deltaToolCalls) {
              const idx = dtc.index;
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  id: dtc.id || '',
                  type: 'function',
                  function: {
                    name: dtc.function?.name || '',
                    arguments: dtc.function?.arguments || '',
                  },
                };
              } else {
                if (dtc.id) toolCalls[idx].id = dtc.id;
                if (dtc.function?.name) {
                  toolCalls[idx].function.name += dtc.function.name;
                }
                if (dtc.function?.arguments) {
                  toolCalls[idx].function.arguments += dtc.function.arguments;
                }
              }
            }
          }

          if (choices?.[0]?.finish_reason) {
            finishReason = choices[0].finish_reason as string;
          }
        }
      }

      callbacks.onComplete({
        content: content || null,
        tool_calls: toolCalls,
        finish_reason: finishReason,
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        callbacks.onError(err as Error);
      }
    }
  })();

  return controller;
}
