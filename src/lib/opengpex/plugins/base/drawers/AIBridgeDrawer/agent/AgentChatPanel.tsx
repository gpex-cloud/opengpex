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
"use client";

/**
 * AgentChatPanel — floating conversation UI.
 *
 * Rendered via EditorPortal from AgentDockButton.
 * Features: agent selector, settings shortcut, neutral color scheme.
 */

import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  Send,
  Square,
  Trash2,
  X,
  Settings,
  ChevronDown,
  Bot,
  Plus,
  MessageSquare,
  Copy,
  Check,
  Download,
  RefreshCw,
} from "lucide-react";
import { usePluginSelfConfig } from "@opengpex/editor/core/context";
import { usePluginCommands } from "@opengpex/editor/core/context";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import DelayedConfirm from "@opengpex/editor/widgets/DelayedConfirm";
import type { AIBridgeConfig } from "../protocols";
import type { AIBridgeDrawerCommandsMap } from "../commands.d";
import { requestAgentsTab } from "../panels/EndPointSettings";
import { useAgentChat, type ChatBubble } from "./hooks";

interface AgentChatPanelProps {
  onClose: () => void;
  hintDismissed: boolean;
  onDismissHint: () => void;
}

/** Format a timestamp as a relative label (e.g. "just now", "2h ago", "3 days ago"). */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function AgentChatPanel({
  onClose,
  hintDismissed,
  onDismissHint,
}: AgentChatPanelProps) {
  const [config, setConfig] = usePluginSelfConfig<AIBridgeConfig>();
  const { openSettingsCmd } = usePluginCommands<AIBridgeDrawerCommandsMap>();
  const {
    bubbles,
    status,
    error,
    streamingText,
    send,
    stop,
    retry,
    canRetry,
    isReady,
    sessions,
    newChat,
    switchSession,
    deleteSession,
    downloadChat,
  } = useAgentChat();

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Whether the message list is scrolled (near) the bottom. When the user
  // scrolls up to read history we must NOT yank them back down on every token.
  const stickToBottomRef = useRef(true);
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Agent selector options
  const agents = config.agents || [];
  const activeAgent = agents.find((a) => a.id === config.activeAgentId);
  const agentOptions = useMemo(
    () =>
      (config.agents || []).map((a) => ({
        label: a.name,
        value: a.id,
        checked: a.id === config.activeAgentId,
      })),
    [config.agents, config.activeAgentId],
  );
  const switchAgent = (agentId: string) => {
    setConfig({ activeAgentId: agentId });
  };

  // Auto-scroll to the bottom on new content — but only when the user is
  // already near the bottom (so scrolling up to read history is respected).
  // During streaming we use instant ('auto') scrolling to avoid overlapping
  // smooth animations restarting on every token (visible flicker).
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: status === "streaming" ? "auto" : "smooth",
    });
  }, [bubbles, streamingText, status]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = () => {
    const text = input.trim();
    if (!text || status === "streaming") return;
    setInput("");
    // Reset textarea height
    if (inputRef.current) inputRef.current.style.height = "auto";
    send(text);
  };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // Stop all keyboard events from propagating to HotkeyManager
    e.stopPropagation();
  };

  return (
    <div className="w-[440px] max-h-[540px] flex flex-col overflow-hidden">
      {/* Scoped Markdown styles for assistant bubbles */}
      <style>{`
        .agent-md strong { font-weight: 700; }
        .agent-md em { font-style: italic; }
        .agent-md .agent-md-code {
          background: var(--bg-stage); padding: 1px 4px; border-radius: 4px;
          font-family: ui-monospace, monospace; font-size: 10.5px;
        }
        .agent-md .agent-md-pre {
          background: var(--bg-stage); border-radius: 6px; padding: 8px 10px;
          margin: 4px 0; overflow-x: auto; font-size: 10.5px;
          font-family: ui-monospace, monospace; line-height: 1.5;
          white-space: pre-wrap; word-break: break-all;
        }
        .agent-md .agent-md-pre code { background: none; padding: 0; }
        .agent-md .agent-md-h2 { font-weight: 800; font-size: 13px; margin: 6px 0 2px; }
        .agent-md .agent-md-h3 { font-weight: 700; font-size: 12px; margin: 5px 0 2px; }
        .agent-md .agent-md-h4 { font-weight: 700; font-size: 11.5px; margin: 4px 0 1px; }
        .agent-md .agent-md-ul, .agent-md .agent-md-ol {
          margin: 2px 0; padding-left: 18px;
        }
        .agent-md .agent-md-ul { list-style-type: disc; }
        .agent-md .agent-md-ol { list-style-type: decimal; }
        .agent-md .agent-md-ul li, .agent-md .agent-md-ol li { margin: 1px 0; }
        .agent-md .agent-md-hr {
          border: none; border-top: 1px solid var(--border-subtle); margin: 6px 0;
        }
        .agent-md .agent-md-link {
          color: #3b82f6; text-decoration: underline;
          text-decoration-color: #3b82f680; text-underline-offset: 2px;
        }
        .agent-md .agent-md-link:hover { text-decoration-color: #3b82f6; }
        /* "Thinking…" indicator: three bouncing dots + shimmering label */
        @keyframes agent-think-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.35; }
          40% { transform: translateY(-3px); opacity: 1; }
        }
        @keyframes agent-think-shimmer {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 1; }
        }
        .agent-think-label { animation: agent-think-shimmer 1.4s ease-in-out infinite; }
        .agent-think-dot {
          display: inline-block; width: 3px; height: 3px; border-radius: 9999px;
          background: currentColor; animation: agent-think-bounce 1.2s ease-in-out infinite;
        }
        .agent-think-dot:nth-child(2) { animation-delay: 0.16s; }
        .agent-think-dot:nth-child(3) { animation-delay: 0.32s; }
        @media (prefers-reduced-motion: reduce) {
          .agent-think-label, .agent-think-dot { animation: none; }
        }
      `}</style>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {agents.length > 1 ? (
            <ActionDropdown
              options={agentOptions}
              onSelect={switchAgent}
              trigger={(isOpen) => (
                <span
                  className={`flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                    isOpen
                      ? "text-[var(--text-main)]"
                      : "text-[var(--text-main)] hover:text-amber-500"
                  }`}
                >
                  <Bot size={14} className="text-amber-500 shrink-0" />
                  {activeAgent?.name || "Agent"}
                  <ChevronDown size={10} className="opacity-60" />
                </span>
              )}
            />
          ) : (
            <span className="flex items-center gap-1 text-[11px] font-bold text-[var(--text-main)] uppercase tracking-wider truncate">
              <Bot size={14} className="text-amber-500 shrink-0" />
              {activeAgent?.name || "Agent Copilot"}
            </span>
          )}
          <button
            onClick={() => {
              requestAgentsTab();
              openSettingsCmd?.execute();
            }}
            title="Agent Settings"
            className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
          >
            <Settings size={12} />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={newChat}
            title="New Chat"
            className="p-1 rounded-md text-[var(--text-muted)] hover:text-amber-500 transition-colors"
          >
            <Plus size={12} />
          </button>
          {sessions.length >= 1 && (
            <ActionDropdown
              options={sessions.map((s) => ({
                label: s.title,
                value: s.id,
                checked: s.isActive,
                description: relativeTime(s.createdAt),
              }))}
              onSelect={switchSession}
              maxVisibleItems={6}
              direction="up"
              trigger={(isOpen) => (
                <span
                  className={`relative p-1 rounded-md transition-colors cursor-pointer flex items-center ${isOpen ? "text-[var(--text-main)]" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
                >
                  <MessageSquare size={12} />
                  <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-amber-500 text-[8px] font-black text-white leading-none px-[3px]">
                    {sessions.length}
                  </span>
                </span>
              )}
            />
          )}
          <button
            onClick={() => {
              const s = sessions.find((x) => x.isActive);
              if (s) downloadChat(s.id);
            }}
            disabled={!sessions.some((x) => x.isActive && x.messageCount > 0)}
            title="Download chat (Markdown)"
            className="p-1 rounded-md text-[var(--text-muted)] hover:text-amber-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-[var(--text-muted)]"
          >
            <Download size={12} />
          </button>
          <DelayedConfirm
            onConfirm={() => {
              const s = sessions.find((x) => x.isActive);
              if (s) deleteSession(s.id);
            }}
            variant="circular"
            ringColor="text-rose-500"
            delayTime={2000}
          >
            <div
              className="p-1 rounded-md text-[var(--text-muted)] hover:text-rose-400 transition-colors"
              title="Delete chat"
            >
              <Trash2 size={12} />
            </div>
          </DelayedConfirm>
          <button
            onClick={onClose}
            title="Close"
            className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Model capability hint */}
      {!hintDismissed && (
        <div className="flex items-start gap-1.5 px-3 py-1.5 bg-amber-500/5 border-b border-[var(--border-subtle)]">
          <p className="flex-1 text-[10px] text-[var(--text-muted)] leading-snug">
            <span className="font-bold text-amber-500/80">Tip:</span> Agent
            features (tool calling, doc search, multi-step workflows) require a
            capable model. Small/local models ({"<"}8B) may not reliably use
            tools.
          </p>
          <button
            onClick={onDismissHint}
            className="shrink-0 mt-0.5 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
            title="Dismiss"
          >
            <X size={10} />
          </button>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 pt-3 pb-2 flex flex-col gap-2 min-h-[200px] max-h-[400px]"
      >
        {!isReady && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <span className="text-[10.5px] text-[var(--text-muted)] font-bold leading-relaxed">
              No active Agent configured.
            </span>
            <button
              onClick={() => openSettingsCmd?.execute()}
              className="text-[10px] font-bold text-amber-500 hover:text-amber-400 transition-colors uppercase tracking-wider"
            >
              Open AI Settings →
            </button>
          </div>
        )}
        {bubbles.map((b) => (
          <MessageBubble key={b.id} bubble={b} />
        ))}
        {/* Streaming indicator */}
        {status === "streaming" && streamingText && (
          <StreamingBubble text={streamingText} />
        )}
        {status === "streaming" && !streamingText && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 px-3 py-2 rounded-2xl rounded-bl-sm bg-[var(--bg-stage)] text-[11px] text-[var(--text-muted)]">
              <span className="agent-think-label italic">Thinking</span>
              <span className="flex items-center gap-0.5">
                <span className="agent-think-dot" />
                <span className="agent-think-dot" />
                <span className="agent-think-dot" />
              </span>
            </div>
          </div>
        )}
        {error && (
          <div className="text-[10.5px] text-rose-400 font-bold px-2 py-1">
            Error: {error}
          </div>
        )}
        {canRetry && status !== "streaming" && (
          <div className="flex justify-center py-1">
            <button
              onClick={retry}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-stage)] text-[10.5px] font-bold text-[var(--text-muted)] hover:text-amber-500 hover:border-amber-500/40 transition-colors"
              title="Regenerate the last response"
            >
              <RefreshCw size={11} />
              Retry
            </button>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="flex items-end gap-2 px-3 py-2 border-t border-[var(--border-subtle)]">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            // Auto-resize height
            const el = e.target;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 120) + "px";
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            isReady
              ? "Ask the agent… (Shift+Enter for new line)"
              : "Configure an agent first"
          }
          disabled={!isReady}
          rows={1}
          className="flex-1 bg-[var(--bg-stage)] border border-[var(--border-subtle)] rounded-lg px-2.5 py-1.5 text-[11.5px] text-[var(--text-main)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--text-muted)] focus:ring-1 focus:ring-[var(--text-muted)]/30 transition-all disabled:opacity-50 resize-none overflow-y-hidden"
          style={{ maxHeight: 120 }}
        />
        {status === "streaming" ? (
          <button
            onClick={stop}
            title="Stop generating"
            className="p-2 rounded-lg bg-rose-500/20 text-rose-400 hover:bg-rose-500/30 transition-colors"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!isReady || !input.trim()}
            title="Send"
            className="p-2 rounded-lg bg-[var(--text-main)] text-[var(--bg-panel)] hover:opacity-80 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Bubble ─────────────────────────────────────────────────────────────────────

/**
 * Lightweight Markdown → HTML for chat bubbles.
 * Covers: bold, italic, inline code, code blocks, links, headings (h2-h4),
 * unordered/ordered lists, horizontal rules. No new dependencies.
 *
 * Content comes from LLM output (not user input), XSS risk is minimal.
 */
function renderMarkdown(md: string): string {
  let html = md
    // Escape HTML entities first
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Code blocks (``` ... ```)
    .replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_m, _lang, code) =>
        `<pre class="agent-md-pre"><code>${code.trimEnd()}</code></pre>`,
    )
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="agent-md-code">$1</code>')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Headings (### h3, ## h2 — at line start)
    .replace(/^#### (.+)$/gm, '<div class="agent-md-h4">$1</div>')
    .replace(/^### (.+)$/gm, '<div class="agent-md-h3">$1</div>')
    .replace(/^## (.+)$/gm, '<div class="agent-md-h2">$1</div>')
    // Horizontal rule
    .replace(/^---$/gm, '<hr class="agent-md-hr"/>')
    // Links [text](url)
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener" class="agent-md-link">$1</a>',
    );

  // Process lists: convert consecutive lines starting with - or 1. into <ul>/<ol>
  html = html.replace(/(^[ \t]*[-*] .+$(\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((l) => `<li>${l.replace(/^[ \t]*[-*] /, "")}</li>`)
      .join("");
    return `<ul class="agent-md-ul">${items}</ul>`;
  });
  html = html.replace(/(^[ \t]*\d+\. .+$(\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((l) => `<li>${l.replace(/^[ \t]*\d+\. /, "")}</li>`)
      .join("");
    return `<ol class="agent-md-ol">${items}</ol>`;
  });

  // Paragraphs: double newlines → <br/><br/>, single newlines (not after block elements) → <br/>
  html = html.replace(/\n\n+/g, "<br/><br/>").replace(/\n/g, "<br/>");

  return html;
}

function MessageBubbleBase({ bubble }: { bubble: ChatBubble }) {
  const isUser = bubble.role === "user";
  const [copied, setCopied] = useState(false);
  // Cache the Markdown → HTML conversion so it only runs when the content
  // actually changes — not on every parent re-render (typing, scrolling, etc.).
  const html = useMemo(
    () => (isUser ? "" : renderMarkdown(bubble.content)),
    [isUser, bubble.content],
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(bubble.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className={`group/bubble flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`relative max-w-[85%] px-3 py-2 rounded-2xl text-[11.5px] leading-relaxed break-words select-text agent-md ${
          isUser
            ? "rounded-br-sm bg-blue-500/15 text-[var(--text-main)] whitespace-pre-wrap"
            : "rounded-bl-sm bg-[var(--bg-stage)] text-[var(--text-main)]"
        }`}
      >
        {isUser ? (
          bubble.content
        ) : (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        )}
        {bubble.content && (
          <button
            onClick={handleCopy}
            className="absolute -bottom-0.5 right-1 opacity-0 group-hover/bubble:opacity-100 transition-opacity p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-main)]"
            title="Copy"
          >
            {copied ? (
              <Check size={11} className="text-emerald-500" />
            ) : (
              <Copy size={11} />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized so a bubble only re-renders when its own content changes.
 * Prevents the whole history from re-running renderMarkdown on every keystroke
 * / scroll / streaming token in the parent panel.
 */
const MessageBubble = React.memo(MessageBubbleBase);

/**
 * Live streaming assistant bubble. Memoized on `text` so it only re-parses
 * Markdown when a new token arrives — not when the parent panel re-renders for
 * unrelated reasons (e.g. the user typing in the input box).
 */
const StreamingBubble = React.memo(function StreamingBubble({
  text,
}: {
  text: string;
}) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-bl-sm bg-[var(--bg-stage)] text-[11.5px] text-[var(--text-main)] leading-relaxed break-words agent-md">
        <div dangerouslySetInnerHTML={{ __html: html }} />
        <span className="inline-block w-1.5 h-3 bg-[var(--text-muted)] animate-pulse ml-0.5 rounded-sm opacity-60" />
      </div>
    </div>
  );
});
