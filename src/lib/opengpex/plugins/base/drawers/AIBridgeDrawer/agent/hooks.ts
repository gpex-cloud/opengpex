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
'use client';

/**
 * useAgentChat — manages multi-session agent conversation state.
 *
 * Sessions are **agent-independent**: the user can switch agents mid-conversation.
 * All sessions live in a single global `AgentChatStore` (not per-agent).
 * History is persisted to IndexedDB via pluginConfig.
 *
 * ── Design invariants ──────────────────────────────────────────────────────
 * 1. Sessions are created **only** when the user sends the first message.
 *    `newChat()` simply resets `activeSessionId` to null (= blank slate).
 *    There are NEVER empty sessions in the store.
 *
 * 2. Store reads/writes go through a ref (`storeRef`) that is eagerly
 *    updated on every write, eliminating stale-closure races between
 *    `saveStore` calls in the same tick.
 *
 * 3. Each streaming turn captures `streamingForRef = sessionId` at call
 *    time.  `persistSession` always writes to *that* session, even if the
 *    user switches sessions mid-stream.
 *
 * 4. `stop()` flushes the partial response into the store (no data loss).
 * ────────────────────────────────────────────────────────────────────────────
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { usePluginSelfConfig } from '@opengpex/editor/core/context';
import { useEditorServices, useEditorState } from '@opengpex/editor/core/context';
import type { AIBridgeConfig, AgentDef, AgentChatStore, AgentChatSession } from '../protocols';
import type { AgentMessage } from '../adapters/types';
import { runAgentTurn } from './loop';
import type { EditorSnapshot } from './executor';

export type ChatStatus = 'idle' | 'streaming' | 'error';

/** Stable empty-store reference (module-level so render-time derivation keeps a
 * constant identity when the user has no persisted sessions yet). */
const EMPTY_STORE: AgentChatStore = { sessions: [], activeSessionId: null };


export interface ChatBubble {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
}

export interface SessionInfo {
  id: string;
  title: string;
  isActive: boolean;
  createdAt: number;
  messageCount: number;
}

export interface UseAgentChatReturn {
  bubbles: ChatBubble[];
  status: ChatStatus;
  error: string | null;
  streamingText: string;
  send: (text: string) => void;
  stop: () => void;
  clear: () => void;
  /** Re-run the last user turn (after stop or error). */
  retry: () => void;
  /** True when the last turn ended without a reply → show a retry affordance. */
  canRetry: boolean;
  isReady: boolean;
  /** All chat sessions (agent-independent). */
  sessions: SessionInfo[];
  /** Start a new empty chat session. */
  newChat: () => void;
  /** Switch to an existing session. */
  switchSession: (sessionId: string) => void;
  /** Delete a session (switches to another if active). */
  deleteSession: (sessionId: string) => void;
  /** Download a session as a Markdown file. Defaults to the active session. */
  downloadChat: (sessionId?: string) => void;
}

export function useAgentChat(): UseAgentChatReturn {
  const [config, setConfig] = usePluginSelfConfig<AIBridgeConfig>();
  const { actions } = useEditorServices();
  const { state, activeFrame, activeLayer } = useEditorState();

  // ─── Editor snapshot (ref-based, never stale) ────────────────────────────
  // The ref lets async callbacks (streaming loop) read the freshest editor
  // state without being captured as a stale closure. We sync it in an effect
  // rather than during render (refs must not be written while rendering).
  const editorSnapshotRef = useRef<EditorSnapshot>({ state, activeFrame, activeLayer });
  useEffect(() => {
    editorSnapshotRef.current = { state, activeFrame, activeLayer };
  }, [state, activeFrame, activeLayer]);
  const getEditorSnapshot = useCallback(() => editorSnapshotRef.current, []);

  // ─── Resolve active agent + endpoint ─────────────────────────────────────
  const resolved = useMemo(() => {
    const agents: AgentDef[] = config.agents || [];
    const agent = agents.find((a) => a.id === config.activeAgentId);
    if (!agent) return null;
    const endpoint = (config.endpoints || []).find((e) => e.id === agent.endpointId);
    if (!endpoint) return null;
    return { agent, endpoint };
  }, [config.agents, config.activeAgentId, config.endpoints]);

  // ─── UI state ────────────────────────────────────────────────────────────
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  // True when the last turn ended without a reply (stopped or errored) → offer retry.
  const [canRetry, setCanRetry] = useState(false);
  const messagesRef = useRef<AgentMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const bubbleIdRef = useRef(0);
  const nextId = () => `msg-${++bubbleIdRef.current}`;

  // ─── Streaming token buffer (rAF-coalesced) ──────────────────────────────
  // Tokens can arrive dozens of times per second. Calling setStreamingText on
  // every token forces a re-render + Markdown re-parse each time (CPU spikes,
  // fan noise). Instead we buffer incoming tokens and flush the accumulated
  // text at most once per animation frame.
  const streamBufRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const flushStream = useCallback(() => {
    rafRef.current = null;
    setStreamingText(streamBufRef.current);
  }, []);
  const scheduleFlush = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(flushStream);
  }, [flushStream]);
  const cancelFlush = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);
  // Clean up any pending frame on unmount.
  useEffect(() => () => cancelFlush(), [cancelFlush]);

  // ─── Store helpers ───────────────────────────────────────────────────────
  //
  // `config.agentChatStore` is the single source of truth. `store` is derived
  // from it during render (memoized). `storeRef` mirrors it for callbacks that
  // run outside render (event handlers, async streaming) — it is synced via an
  // effect, and updated eagerly inside `saveStore` so multiple writes in the
  // same tick read the latest value instead of a stale closure.
  const store = useMemo<AgentChatStore>(
    () =>
      config.agentChatStore && Array.isArray(config.agentChatStore.sessions)
        ? config.agentChatStore
        : EMPTY_STORE,
    [config.agentChatStore],
  );

  const storeRef = useRef<AgentChatStore>(store);
  useEffect(() => { storeRef.current = store; }, [store]);

  const getStore = useCallback((): AgentChatStore => {
    return storeRef.current;
  }, []);

  const saveStore = useCallback((next: AgentChatStore) => {
    storeRef.current = next; // eager update — subsequent reads see this immediately
    setConfig({ agentChatStore: next });
  }, [setConfig]);

  const buildBubbles = (msgs: AgentMessage[]): ChatBubble[] =>
    msgs
      .filter((m) => {
        if (m.role === 'user') return true;
        // Assistant turns that are pure tool-call carriers have empty content
        // (the visible reply arrives in a later assistant message). Skipping
        // them avoids rendering blank bubbles when a session is reopened.
        if (m.role === 'assistant') return !!(m.content && m.content.trim().length > 0);
        return false;
      })
      .map((m) => ({ id: nextId(), role: m.role as ChatBubble['role'], content: m.content || '' }));

  // ─── Derived state ───────────────────────────────────────────────────────
  const activeSessionId = store.activeSessionId;

  // Track which session the current streaming turn belongs to.
  // Captured at send() time; used by persistSession/stop so that
  // a mid-stream session switch doesn't corrupt data.
  const streamingForRef = useRef<string | null>(null);

  const loadKey = activeSessionId ?? '__new__';
  const loadedKeyRef = useRef<string | null>(null);

  // ─── Restore on session switch ──────────────────────────────────────────
  // Synchronizes local UI state when the active session changes. Guarded by
  // `loadedKeyRef` so it only runs on an actual session switch (not every
  // render), so the setState calls here don't cascade. This is an intentional
  // imperative reset, hence the scoped rule disable.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (loadKey === loadedKeyRef.current) return;
    loadedKeyRef.current = loadKey;

    if (!activeSessionId) {
      // null activeSessionId = "new chat" blank slate
      messagesRef.current = [];
      setBubbles([]);
      setError(null);
      setStreamingText('');
      setCanRetry(false);
      return;
    }

    const session = store.sessions.find((s) => s.id === activeSessionId);
    if (!session) {
      // Session was deleted externally — fall back to blank slate
      saveStore({ ...store, activeSessionId: null });
      return;
    }

    messagesRef.current = [...session.messages];
    setBubbles(buildBubbles(session.messages));
    setError(null);
    setStreamingText('');
    // A restored session may end on an unanswered user message (e.g. stopped
    // then refreshed) — offer retry in that case.
    setCanRetry(session.messages.length > 0 && session.messages[session.messages.length - 1].role === 'user');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ─── persistSession — writes messagesRef into the store ──────────────────
  // Uses streamingForRef so it always writes to the correct session,
  // regardless of what the user navigated to during the stream.
  const persistSession = useCallback((targetSessionId?: string) => {
    const sid = targetSessionId ?? streamingForRef.current;
    if (!sid) return;
    const s = getStore();
    const session = s.sessions.find((x) => x.id === sid);
    if (!session) return;

    const msgs = [...messagesRef.current];
    // Auto-title: replace "New Chat" with first user message (truncated)
    const title = session.title === 'New Chat'
      ? (msgs.find((m) => m.role === 'user')?.content?.slice(0, 40) || 'New Chat')
      : session.title;

    saveStore({
      ...s,
      sessions: s.sessions.map((x) =>
        x.id === sid ? { ...x, messages: msgs, title } : x,
      ),
    });
  }, [getStore, saveStore]);

  // ─── Session list (for UI) ──────────────────────────────────────────────
  // No filtering needed — sessions in the store always have messages.
  const sessions: SessionInfo[] = useMemo(
    () => (store.sessions || [])
      .map((s) => ({
        id: s.id,
        title: s.title,
        isActive: s.id === activeSessionId,
        createdAt: s.createdAt,
        messageCount: s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
      }))
      .sort((a, b) => b.createdAt - a.createdAt),
    [store.sessions, activeSessionId],
  );

  // ─── newChat ─────────────────────────────────────────────────────────────
  // Simply deactivates the current session → UI shows blank input.
  // A real session is created atomically in send() on first message.
  const newChat = useCallback(() => {
    // Already in "new chat" mode — nothing to do
    if (!activeSessionId) return;

    const s = getStore();
    saveStore({ ...s, activeSessionId: null });
    // Clear UI immediately (restore effect will also fire, but we clear eagerly
    // to avoid a flash of stale bubbles)
    messagesRef.current = [];
    setBubbles([]);
    setError(null);
    setStreamingText('');
    setCanRetry(false);
  }, [activeSessionId, getStore, saveStore]);

  // ─── switchSession ───────────────────────────────────────────────────────
  const switchSession = useCallback((sid: string) => {
    const s = getStore();
    // Validate the target session exists
    if (!s.sessions.some((x) => x.id === sid)) return;
    saveStore({ ...s, activeSessionId: sid });
  }, [getStore, saveStore]);

  // ─── deleteSession ───────────────────────────────────────────────────────
  const deleteSession = useCallback((sid: string) => {
    const s = getStore();
    const remaining = s.sessions.filter((x) => x.id !== sid);
    let nextActive = s.activeSessionId;
    if (s.activeSessionId === sid) {
      // Pick the most recent remaining session, or null (blank slate)
      nextActive = remaining.length > 0
        ? remaining.reduce((a, b) => a.createdAt > b.createdAt ? a : b).id
        : null;
    }
    saveStore({ sessions: remaining, activeSessionId: nextActive });

    // If we deleted the active session, clear UI eagerly
    if (s.activeSessionId === sid) {
      messagesRef.current = [];
      setBubbles([]);
      setError(null);
      setStreamingText('');
      setCanRetry(false);
    }
  }, [getStore, saveStore]);

  // ─── send ────────────────────────────────────────────────────────────────
  const send = useCallback((text: string) => {
    if (!resolved || status === 'streaming') return;
    const { agent, endpoint } = resolved;

    // Determine / create the session for this turn
    let sessionId = activeSessionId;
    if (!sessionId) {
      // Atomic session creation — the session is born with a title, never empty
      const s = getStore();
      sessionId = `sess-${crypto.randomUUID().slice(0, 8)}`;
      const session: AgentChatSession = {
        id: sessionId,
        title: text.slice(0, 40),
        createdAt: Date.now(),
        messages: [],
      };
      saveStore({ sessions: [...s.sessions, session], activeSessionId: sessionId });
      // Update loadedKeyRef so the restore effect doesn't re-trigger
      loadedKeyRef.current = sessionId;
    }

    // Lock the streaming target — used by persistSession and stop
    streamingForRef.current = sessionId;

    setBubbles((prev) => [...prev, { id: nextId(), role: 'user', content: text }]);
    setStatus('streaming');
    setError(null);
    streamBufRef.current = '';
    cancelFlush();
    setStreamingText('');
    setCanRetry(false);

    abortRef.current = runAgentTurn(text, {
      endpoint,
      model: agent.model,
      messages: messagesRef.current,
      actions,
      behaviorPreset: agent.behaviorPreset,
      getEditorSnapshot,
      onToken: (t) => { streamBufRef.current += t; scheduleFlush(); },
      onComplete: (result) => {
        cancelFlush();
        setBubbles((prev) => [...prev, { id: nextId(), role: 'assistant', content: result.content || '' }]);
        streamBufRef.current = '';
        setStreamingText('');
        setStatus('idle');
        setCanRetry(false);
        abortRef.current = null;
        persistSession(sessionId);
        streamingForRef.current = null;
      },
      onError: (err) => {
        cancelFlush();
        setError(err.message);
        streamBufRef.current = '';
        setStreamingText('');
        setStatus('error');
        setCanRetry(true);
        abortRef.current = null;
        // Still persist what we have (the user message at minimum)
        persistSession(sessionId);
        streamingForRef.current = null;
      },
    });
  }, [resolved, status, actions, activeSessionId, getStore, saveStore, persistSession, getEditorSnapshot, scheduleFlush, cancelFlush]);

  // ─── stop ────────────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    cancelFlush();
    // The buffer holds the freshest partial text (may be ahead of the last
    // flushed state), so flush the stopped bubble from it.
    const partial = streamBufRef.current;
    if (partial) setBubbles((b) => [...b, { id: nextId(), role: 'assistant', content: partial + ' [stopped]' }]);
    streamBufRef.current = '';
    setStreamingText('');
    setStatus('idle');
    // The turn ended with an unanswered user message → allow retry.
    setCanRetry(messagesRef.current.some((m) => m.role === 'user'));
    // Flush to store so a refresh doesn't lose the conversation
    const sid = streamingForRef.current;
    if (sid) {
      // runAgentTurn pushes to messagesRef synchronously before onToken,
      // so by the time the user clicks stop, messagesRef is already up to date.
      persistSession(sid);
      streamingForRef.current = null;
    }
  }, [persistSession, cancelFlush]);

  // ─── retry (re-run the last user turn) ───────────────────────────────────
  // After stop() or an error, the last message in history is a user message
  // with no assistant reply. retry() truncates history back to (and including)
  // that user message, then re-sends it — producing a fresh generation.
  const retry = useCallback(() => {
    if (!resolved || status === 'streaming') return;
    const msgs = messagesRef.current;
    let lastUser: Extract<AgentMessage, { role: 'user' }> | null = null;
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'user') { lastUser = m; lastUserIdx = i; break; }
    }
    if (!lastUser) return;
    const text = lastUser.content;

    // Drop the last user message + everything after it; send() re-appends it.
    messagesRef.current = msgs.slice(0, lastUserIdx);
    setBubbles(buildBubbles(messagesRef.current));
    setError(null);
    send(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, status, send]);
  const clear = useCallback(() => {
    stop();
    if (activeSessionId) {
      // Remove the session entirely (no empty sessions in the store)
      const s = getStore();
      const remaining = s.sessions.filter((x) => x.id !== activeSessionId);
      const nextActive = remaining.length > 0
        ? remaining.reduce((a, b) => a.createdAt > b.createdAt ? a : b).id
        : null;
      saveStore({ sessions: remaining, activeSessionId: nextActive });
    }
    messagesRef.current = [];
    setBubbles([]);
    setError(null);
  }, [stop, activeSessionId, getStore, saveStore]);

  // ─── downloadChat (export session as Markdown) ───────────────────────────
  const downloadChat = useCallback((sessionId?: string) => {
    const sid = sessionId ?? activeSessionId;
    if (!sid) return;
    const session = getStore().sessions.find((x) => x.id === sid);
    if (!session) return;

    // Only user/assistant turns are meaningful in an exported transcript.
    const turns = session.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    if (turns.length === 0) return;

    const date = new Date(session.createdAt);
    const lines: string[] = [
      `# ${session.title}`,
      '',
      `> Exported from OpenGPEX Agent Copilot on ${new Date().toLocaleString()}`,
      `> Session created: ${date.toLocaleString()}`,
      '',
      '---',
      '',
    ];
    for (const m of turns) {
      const who = m.role === 'user' ? '🧑 **You**' : '🤖 **Agent**';
      lines.push(who, '', (m.content || '').trim(), '', '---', '');
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const safeTitle = session.title.replace(/[^\w\u4e00-\u9fa5- ]+/g, '').trim().slice(0, 60) || 'chat';
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-chat_${safeTitle}_${stamp}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [activeSessionId, getStore]);

  return {
    bubbles, status, error, streamingText,
    send, stop, clear, retry, canRetry, isReady: !!resolved,
    sessions, newChat, switchSession, deleteSession, downloadChat,
  };
}
