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
 * Agent conversation loop — drives the streaming chat cycle
 * with multi-round tool calling support.
 *
 * Phase 1.5 Step 0: Each round auto-injects a compact state snapshot
 * into the system prompt (~60 tokens). The snapshot refreshes every
 * round so the Agent always sees up-to-date editor state.
 */

import type { AIEndpoint, AgentMessage } from '../adapters/types';
import type { EditorActions } from '@opengpex/editor/core/types';
import type { AgentBehaviorPreset } from '../protocols';
import {
  streamChatCompletionsForAgent,
  type AgentChatResult,
} from '../adapters/openai-compat';
import { AGENT_TOOLS } from './tools';
import { executeAgentTool, type AgentExecutorContext, type EditorSnapshot } from './executor';
import { getSkillCatalog } from './skills';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';

/** Maximum messages kept in history. */
const MAX_HISTORY = 50;

/** Maximum tool-calling rounds per user turn (safety limit). */
const MAX_TOOL_ROUNDS = 5;

/** Base system prompt — always controlled by code, never exposed to users. */
const SYSTEM_PROMPT_BASE = [
  'You are an AI assistant embedded in OpenGPEX, an open-source web-based graphics and photo editor.',
  'You help users with image editing tasks. In OpenGPEX, each open image is called a "frame". Users may have multiple frames open.',
  'You have access to tools that can manipulate the current image. Use them when the user asks you to perform visual transformations.',
  'Beyond editing images, you can also help users learn how to use OpenGPEX — answering questions about its features, tools, shortcuts, and workflows by searching the documentation. When you introduce yourself or list what you can do, mention this help capability alongside your image-editing abilities.',
  'After using a tool, briefly confirm what you did.',
  'Never mention tool names, function names, or internal implementation details to the user. Speak naturally about what you did.',
  'Do not decorate your replies with emoji or icons — especially not in headings. Keep formatting clean and plain.',
  'You have NO built-in knowledge about OpenGPEX features, shortcuts, or workflows. When the user asks "how do I…", "what is…", or anything about OpenGPEX itself, you MUST call search_docs first. Never guess or fabricate answers about this product.',
  'The [State] line at the end of this prompt reflects the LIVE editor state right now. Always base your responses on [State], not on memory of earlier actions. If the user questions a result, call get_editor_state to verify before responding.',
].join(' ');

/** Behavior suffix appended to the base prompt per preset. */
const BEHAVIOR_SUFFIX: Record<AgentBehaviorPreset, string> = {
  auto: '',
  concise: ' Be very brief. After a tool action, confirm in one short sentence. Skip explanations unless asked.',
  detailed: ' Explain each step before and after execution. When using tools, describe what you are about to do and what happened.',
};

function buildSystemPrompt(
  preset: AgentBehaviorPreset = 'auto',
  stateSnapshot?: string,
): string {
  let prompt = SYSTEM_PROMPT_BASE + BEHAVIOR_SUFFIX[preset];

  // Skill catalog (~100 tokens) — names + one-liners only
  const catalog = getSkillCatalog();
  if (catalog) {
    prompt += '\n\n' + catalog;
  }

  // Live state snapshot (~60 tokens) — refreshed every round
  if (stateSnapshot) {
    prompt += '\n\n' + stateSnapshot;
  }
  return prompt;
}

export interface AgentLoopOptions {
  endpoint: AIEndpoint;
  model: string;
  /** Current conversation history (mutated in place). */
  messages: AgentMessage[];
  /** EditorActions for tool execution. */
  actions: EditorActions;
  /** Behavior preset for system prompt style. */
  behaviorPreset?: AgentBehaviorPreset;
  /** Returns a fresh snapshot of the current editor state (ref-based, never stale). */
  getEditorSnapshot: () => EditorSnapshot;
  /** Callback: text token arrived (for typewriter effect). */
  onToken: (token: string) => void;
  /** Callback: full turn completed (final assistant response, no more tool calls). */
  onComplete: (result: AgentChatResult) => void;
  /** Callback: error occurred. */
  onError: (error: Error) => void;
  /** External abort signal. */
  signal?: AbortSignal;
}

/**
 * Runs one user turn through the agent loop.
 *
 * 1. Ensures a system message exists at history[0]
 * 2. Appends the user message
 * 3. Streams the assistant response
 * 4. If tool_calls: execute tools → append results → recurse (up to MAX_TOOL_ROUNDS)
 * 5. Returns an AbortController for cancellation
 */
export function runAgentTurn(
  userText: string,
  opts: AgentLoopOptions,
): AbortController {
  const { messages } = opts;

  // Build state snapshot line (~60 tokens) — refreshed every turn
  const stateSnapshotLine = buildStateSnapshotLine(opts.getEditorSnapshot());

  // Ensure system prompt (rebuild when preset or state may have changed)
  const systemContent = buildSystemPrompt(opts.behaviorPreset, stateSnapshotLine);
  if (messages.length === 0 || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: systemContent });
  } else {
    messages[0].content = systemContent;
  }

  // Append user message
  messages.push({ role: 'user', content: userText });

  // Trim history if too long (keep system + recent messages)
  trimHistory(messages);

  // Start the streaming loop (round 0 = first LLM call)
  return streamRound(opts, 0);
}

/**
 * Internal: stream one round of the conversation.
 * If the result contains tool_calls and rounds < MAX_TOOL_ROUNDS,
 * execute tools, append results, and stream another round.
 */
function streamRound(
  opts: AgentLoopOptions,
  round: number,
): AbortController {
  const { messages, actions, getEditorSnapshot } = opts;

  // Build executor context — state getter is called lazily per tool call
  const executorCtx: AgentExecutorContext = { actions, getEditorSnapshot };

  // Refresh state snapshot in system prompt for this round
  // (tool executions in previous round may have changed the state)
  if (round > 0 && messages.length > 0 && messages[0].role === 'system') {
    const freshLine = buildStateSnapshotLine(getEditorSnapshot());
    messages[0].content = buildSystemPrompt(opts.behaviorPreset, freshLine);
  }

  return streamChatCompletionsForAgent(
    {
      endpoint: opts.endpoint,
      providerName: opts.endpoint.provider,
      model: opts.model,
      messages,
      tools: AGENT_TOOLS,
      signal: opts.signal,
    },
    {
      onToken: opts.onToken,
      onComplete: async (result) => {
        // Append assistant message to history
        messages.push({
          role: 'assistant',
          content: result.content || '',
          tool_calls: result.tool_calls.length > 0 ? result.tool_calls : undefined,
        });

        // If tool_calls exist and we haven't exceeded the limit, execute and recurse
        if (result.tool_calls.length > 0 && round < MAX_TOOL_ROUNDS) {
          // Execute each tool call and append results
          for (const tc of result.tool_calls) {
            const toolResult = await executeAgentTool(tc, executorCtx);
            messages.push({
              role: 'tool',
              content: toolResult,
              tool_call_id: tc.id,
            });
          }

          trimHistory(messages);

          // Start next round (LLM sees tool results and can respond or call more tools)
          streamRound(opts, round + 1);
          return;
        }

        // No tool_calls or limit reached → turn is done
        opts.onComplete(result);
      },
      onError: opts.onError,
    },
  );
}

/** Trims conversation history to MAX_HISTORY, keeping the system message. */
function trimHistory(messages: AgentMessage[]): void {
  while (messages.length > MAX_HISTORY) {
    // Remove the second message (first non-system)
    messages.splice(1, 1);
  }
}

// ─── State snapshot builder ──────────────────────────────────────────────────

/**
 * Build a compact one-line state snapshot for system prompt injection.
 * Target: ~60 tokens. Refreshed every round.
 *
 * Example:
 * ```
 * [State] Frames:2 active:"warrior" 1024×768 | Layers:[0]Background(locked) [1]Layer 1(active,100%) | Zoom:100% | Selection:none
 * ```
 */
function buildStateSnapshotLine(snap: EditorSnapshot): string {
  const { state, activeFrame: frame, activeLayer } = snap;
  const totalFrames = state.frames.order.length;

  if (!frame) return `[State] No frame open | Frames:${totalFrames}`;

  // Frame info
  const framePart = `${totalFrames} frame(s) open, active:"${frame.name}" ${frame.canvas.w}×${frame.canvas.h}`;

  // Layer summary (compact) — only show host layers (hide internal frag/exchange triplet layers)
  const hostLayers = frame.layers.order
    .map((id) => frame.layers.byId[id])
    .filter((l) => !l.role || l.role === 'host');
  const layerParts = hostLayers.map((l, idx) => {
    const flags: string[] = [];
    if (l.id === activeLayer?.id) flags.push('active');
    if (l.locked) flags.push('locked');
    if (!l.visible) flags.push('hidden');
    if (l.opacity < 1) flags.push(`${Math.round(l.opacity * 100)}%`);
    const suffix = flags.length > 0 ? `(${flags.join(',')})` : '';
    return `[${idx}]${l.name}${suffix}`;
  });
  const layersPart = `Layers:${layerParts.join(' ')}`;

  // Zoom
  const zoomPart = `Zoom:${Math.round(frame.camera.k * 100)}%`;

  // Selection
  const hasSelection = !!getClipBox(frame);
  const selPart = hasSelection ? `Selection:${frame.latestClipTool}` : 'Selection:none';

  // Undo/Redo
  const frameHistory = state.history?.byFrameId?.[frame.id];
  const undoCount = (frameHistory?.past?.length ?? 0) + (frameHistory?.checkpoint ? 1 : 0);
  const redoCount = frameHistory?.future?.length ?? 0;
  const historyPart = `Undo:${undoCount} Redo:${redoCount}`;

  return `[State] ${framePart} | ${layersPart} | ${zoomPart} | ${selPart} | ${historyPart}`;
}
