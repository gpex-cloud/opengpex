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
 * useVolatileState.test.ts — 步骤 6 回归门禁：GC 清理必须是标志中性的。
 *
 * 缺陷（缺陷记录 §2 附）：`removeFrame` 先 `resetVolatile()`（interacting=false），
 * 再 dispatch REMOVE_FRAME；`enhancedDispatch` 的 REMOVE_FRAME 分支用 `mutate` 清
 * 影子缓冲，而 `mutate` 无条件置 `interacting=true`，此后无 commit → 标志永久卡 true，
 * 污染快轨节流 / merge 门控 / idle 判断。
 *
 * 修复：新增 `cleanup`（mutate 但不碰 `interacting`），GC 分支改用它。本测试锁住
 * 两个不变量：`mutate` 置 true、`cleanup` 保持原值不变。
 *
 * React hook 依赖（useRef/useCallback）用最小 pass-through 桩替换，从而在纯 Node
 * 下执行 **真实的** `useVolatileState` 源码逻辑（不是复制品）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal pass-through React hook shims so the real hook body runs in Node:
// useRef → a persistent { current } box; useCallback → identity (returns fn).
const refBoxes: Array<{ current: unknown }> = [];
let refCursor = 0;
vi.mock('react', () => ({
  useRef: <T,>(initial: T) => {
    if (refCursor >= refBoxes.length) refBoxes.push({ current: initial });
    return refBoxes[refCursor++] as { current: T };
  },
  useCallback: <T,>(fn: T) => fn,
}));

import { useVolatileState } from './useVolatileState';

beforeEach(() => {
  // Fresh ref store per test so each useVolatileState() call gets a clean ref.
  refBoxes.length = 0;
  refCursor = 0;
});

describe('useVolatileState — GC cleanup is flag-neutral (步骤 6)', () => {
  it('mutate sets interacting=true; cleanup leaves it untouched', () => {
    const h = useVolatileState();

    // baseline
    expect(h.volatileRef.current.activeState.interacting).toBe(false);

    // mutate = real interaction → flips flag true
    h.mutate(v => {
      v.buffered.frames['f1'] = { camera: undefined };
    });
    expect(h.volatileRef.current.activeState.interacting).toBe(true);
    expect(h.volatileRef.current.buffered.frames['f1']).toBeDefined();

    // reset back to a clean, non-interacting state (mirrors removeFrame's first step)
    h.reset();
    expect(h.volatileRef.current.activeState.interacting).toBe(false);

    // cleanup = GC → mutates the buffer but MUST NOT set interacting
    h.volatileRef.current.buffered.frames['dead'] = { camera: undefined };
    h.cleanup(v => {
      delete v.buffered.frames['dead'];
    });
    expect(h.volatileRef.current.buffered.frames['dead']).toBeUndefined();
    expect(h.volatileRef.current.activeState.interacting).toBe(false);
  });

  it('cleanup preserves interacting=true when a real interaction is ongoing', () => {
    const h = useVolatileState();

    // simulate an in-flight interaction
    h.mutate(() => {});
    expect(h.volatileRef.current.activeState.interacting).toBe(true);

    // a GC cleanup during that window must not clobber the flag either way
    h.cleanup(v => {
      delete v.buffered.frames['whatever'];
    });
    expect(h.volatileRef.current.activeState.interacting).toBe(true);
  });
});
