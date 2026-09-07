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
 * Anthropic NATIVE Messages API adapter for Agent tool-calling.
 *
 * WHY THIS EXISTS (and does not reuse openai-compat):
 * Anthropic's OpenAI-compatibility layer (and Bedrock's OpenAI-compat shim)
 * mangle the tool_use/tool_result pairing when converting OpenAI-format
 * messages into Anthropic native content blocks — producing the
 * "unexpected tool_use_id found in tool_result blocks" 400. Talking to the
 * native `/v1/messages` endpoint directly, with proper content blocks, avoids
 * that translation entirely.
 *
 * This module converts our internal OpenAI-style `AgentMessage[]` + OpenAI
 * function-calling `AgentToolDef[]` into Anthropic's native request shape, and
 * parses Anthropic's SSE event stream back into the same `AgentChatResult`
 * that the OpenAI path produces — so `loop.ts` needs no branching.
 */

import type { AgentToolDef, AgentToolCall, AgentMessage } from './types';
import { joinUrl, proxyFetch, readErrorInfo } from './transport';
import type {
  AgentChatOptions,
  AgentChatResult,
  StreamAgentChatCallbacks,
} from './openai-compat';

/** Anthropic requires an explicit version header. */
const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic requires max_tokens; pick a generous default for agent replies. */
const DEFAULT_MAX_TOKENS = 4096;

// ─── Request shape (native Anthropic) ────────────────────────────────────────

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

// ─── Converters: OpenAI-format → Anthropic native ────────────────────────────

/** Convert OpenAI function-calling tools → Anthropic tools. */
function toAnthropicTools(tools: AgentToolDef[] | undefined): AnthropicTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/**
 * Convert our internal message list into Anthropic's shape.
 *
 * Key transformations:
 *  - `system` messages are pulled out into the top-level `system` string.
 *  - assistant `tool_calls` become `tool_use` content blocks.
 *  - `tool` result messages become `tool_result` blocks inside a USER message;
 *    consecutive tool results are merged into a single user message (Anthropic
 *    expects all results for one assistant turn grouped together).
 */
function toAnthropicMessages(messages: AgentMessage[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }

    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }

    if (m.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content && m.content.trim().length > 0) {
        blocks.push({ type: 'text', text: m.content });
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let input: unknown = {};
          try {
            input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            input = {};
          }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      }
      // An assistant turn must have at least one block.
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (m.role === 'tool') {
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: m.content,
      };
      // Merge into the previous user message if it already holds tool_results.
      const prev = out[out.length - 1];
      if (
        prev &&
        prev.role === 'user' &&
        Array.isArray(prev.content) &&
        prev.content.every((b) => b.type === 'tool_result')
      ) {
        prev.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
  }

  return { system: systemParts.join('\n\n'), messages: out };
}

// ─── Streaming (native Anthropic SSE) ────────────────────────────────────────

/**
 * Stream a tool-calling chat turn against the native Anthropic Messages API.
 * Parses Anthropic SSE events and reports back through the same callbacks as
 * the OpenAI path, producing an identical `AgentChatResult`.
 */
export function streamAnthropicMessagesForAgent(
  opts: AgentChatOptions,
  callbacks: StreamAgentChatCallbacks,
): AbortController {
  const controller = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;

  (async () => {
    try {
      const targetUrl = joinUrl(opts.endpoint.baseUrl, '/v1/messages');
      const { system, messages } = toAnthropicMessages(opts.messages);

      const body: Record<string, unknown> = {
        model: opts.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages,
        stream: true,
      };
      if (system) body.system = system;
      const tools = toAnthropicTools(opts.tools);
      if (tools) body.tools = tools;

      const res = await proxyFetch({
        targetUrl,
        apiKey: opts.endpoint.apiKey,
        method: 'POST',
        body: JSON.stringify(body),
        contentType: 'application/json',
        authMode: 'anthropic',
        extraHeaders: { 'anthropic-version': ANTHROPIC_VERSION },
        signal,
      });

      if (!res.ok) {
        const info = await readErrorInfo(res);
        throw new Error(`Agent chat failed (${info.status}): ${info.message}`);
      }
      if (!res.body) {
        throw new Error('Response body is null — streaming not supported by proxy');
      }

      await parseAnthropicStream(res.body, callbacks);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        callbacks.onError(err as Error);
      }
    }
  })();

  return controller;
}

/**
 * Parse the Anthropic SSE event stream.
 *
 * Content blocks arrive as start/delta/stop triplets. We track blocks by
 * index: text blocks accumulate `text_delta.text` (and stream to onToken),
 * tool_use blocks accumulate `input_json_delta.partial_json`. On completion
 * we assemble an `AgentChatResult` matching the OpenAI path.
 */
async function parseAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  callbacks: StreamAgentChatCallbacks,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stopReason = 'end_turn';

  // Per-index accumulation of content blocks.
  interface BlockAcc {
    type: 'text' | 'tool_use';
    id?: string;
    name?: string;
    partialJson: string;
  }
  const blocks = new Map<number, BlockAcc>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }

      const type = evt.type as string;

      if (type === 'content_block_start') {
        const index = evt.index as number;
        const cb = evt.content_block as Record<string, unknown>;
        if (cb?.type === 'tool_use') {
          blocks.set(index, {
            type: 'tool_use',
            id: cb.id as string,
            name: cb.name as string,
            partialJson: '',
          });
        } else {
          blocks.set(index, { type: 'text', partialJson: '' });
        }
      } else if (type === 'content_block_delta') {
        const index = evt.index as number;
        const delta = evt.delta as Record<string, unknown>;
        const acc = blocks.get(index);
        if (delta?.type === 'text_delta') {
          const token = (delta.text as string) || '';
          text += token;
          callbacks.onToken(token);
        } else if (delta?.type === 'input_json_delta' && acc) {
          acc.partialJson += (delta.partial_json as string) || '';
        }
      } else if (type === 'message_delta') {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason as string;
      }
      // content_block_stop / message_start / message_stop / ping → no-op
    }
  }

  // Assemble tool_calls from accumulated tool_use blocks (in index order).
  const toolCalls: AgentToolCall[] = [];
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const b = blocks.get(index)!;
    if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id || '',
        type: 'function',
        function: { name: b.name || '', arguments: b.partialJson || '{}' },
      });
    }
  }

  // Map Anthropic stop_reason → OpenAI-style finish_reason for consistency.
  const finishReason = stopReason === 'tool_use' ? 'tool_calls' : 'stop';

  const result: AgentChatResult = {
    content: text || null,
    tool_calls: toolCalls,
    finish_reason: finishReason,
  };
  callbacks.onComplete(result);
}

