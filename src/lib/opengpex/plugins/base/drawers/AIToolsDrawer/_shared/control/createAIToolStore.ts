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
 * 通用 AI 工具任务状态。所有工具共享相同的 task 结构。
 */
export interface AIToolTask {
  /** 当前阶段描述（显示在 UI 上） */
  message: string;
  /** 0-1 进度（loading 阶段为 0，processing 阶段为实际进度） */
  progress: number;
  /** 检测到的设备 */
  device: 'webgpu' | 'wasm' | null;
  /** 下载相关（仅 downloading 阶段） */
  download?: {
    loaded: number;
    total: number;
    speedBps: number;
  };
}

/**
 * AI 工具 Store 状态。TResult 为工具特定的结果类型。
 */
export interface AIToolStoreState<TResult> {
  /** 非 null = 正在工作，显示进度卡 */
  task: AIToolTask | null;
  /** 上次成功结果（常驻直到用户清除或下次运行覆盖） */
  lastResult: TResult | null;
  /** 错误信息（非 null 时显示错误卡） */
  error: string | null;
}

/**
 * AI 工具 Store 实例。由 createAIToolStore() 返回。
 */
export interface AIToolStore<TResult> {
  /** 获取当前状态快照 */
  getState: () => AIToolStoreState<TResult>;
  /** 订阅状态变化（返回 unsubscribe 函数） */
  subscribe: (fn: () => void) => () => void;
  /** 部分更新状态 */
  setState: (next: Partial<AIToolStoreState<TResult>>) => void;
  /** 重置为初始状态 */
  reset: () => void;
  /** 注册 busy sync（组件 mount 时调用一次） */
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
