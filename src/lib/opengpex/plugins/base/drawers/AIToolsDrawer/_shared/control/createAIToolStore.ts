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
 * createAIToolStore — Generic factory for AI tool module-level stores.
 *
 * Creates a synchronous, tearing-free store instance compatible with
 * React's `useSyncExternalStore`. Each AI tool (BgRemover, Upscaler,
 * Segmentation, Inpaint Eraser) creates its own store via this factory,
 * parameterized by its tool-specific Result type.
 *
 * Features:
 *   - Synchronous writes (no dispatch/commit gap)
 *   - Pub/sub for React subscription
 *   - Auto-derived busy state for Plugin Service (red dot indicator)
 *   - SSR-safe (pure memory, no side effects on import)
 *
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * General AI tool task state. All tools share the same task structure.
 */
export interface AIToolTask {
  /** Current phase description (displayed in UI) */
  message: string;
  /** 0-1 progress value (0 during loading, actual progress during processing) */
  progress: number;
  /** Detected device */
  device: 'webgpu' | 'wasm' | null;
  /** Download details (downloading phase only) */
  download?: {
    loaded: number;
    total: number;
    speedBps: number;
  };
}

/**
 * AI tool store state. TResult is the tool-specific result type.
 */
export interface AIToolStoreState<TResult> {
  /** Non-null when active, renders progress card */
  task: AIToolTask | null;
  /** Last successful result (resident until cleared or overwritten by next run) */
  lastResult: TResult | null;
  /** Error message (renders error card when non-null) */
  error: string | null;
}

/**
 * AI tool store instance returned by createAIToolStore().
 */
export interface AIToolStore<TResult> {
  /** Get current state snapshot */
  getState: () => AIToolStoreState<TResult>;
  /** Subscribe to state changes (returns unsubscribe function) */
  subscribe: (fn: () => void) => () => void;
  /** Partially update state */
  setState: (next: Partial<AIToolStoreState<TResult>>) => void;
  /** Reset to initial state */
  reset: () => void;
  /** Register busy sync (called once when component mounts) */
  initBusySync: (
    plugins: { setBusy(uid: string, busy: boolean): void },
    uid: string,
  ) => void;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a new AI tool store instance.
 *
 * Usage:
 *   const bgStore = createAIToolStore<BgResult>();
 *   const upscaleStore = createAIToolStore<UpscaleResult>();
 */
export function createAIToolStore<TResult>(): AIToolStore<TResult> {
  const INITIAL: AIToolStoreState<TResult> = {
    task: null,
    lastResult: null,
    error: null,
  };

  let state: AIToolStoreState<TResult> = INITIAL;
  const listeners = new Set<() => void>();
  let pluginsRef: { setBusy(uid: string, busy: boolean): void } | null = null;
  let pluginUid: string | null = null;

  function notify(): void {
    if (pluginsRef && pluginUid) {
      pluginsRef.setBusy(pluginUid, state.task !== null);
    }
    for (const fn of listeners) fn();
  }

  return {
    getState: () => state,

    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },

    setState: (next) => {
      state = { ...state, ...next };
      notify();
    },

    reset: () => {
      state = INITIAL;
      notify();
    },

    initBusySync: (plugins, uid) => {
      pluginsRef = plugins;
      pluginUid = uid;
      plugins.setBusy(uid, state.task !== null);
    },
  };
}
