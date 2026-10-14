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

/* eslint-disable react-hooks/set-state-in-effect */

'use client';

import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useEditorState, useEditorServices, usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import * as P from './protocols';
import { calculateDockPosition, calculateBranches, flattenReorderedFrames } from './utils';
import type { TabDockCommandsMap } from './commands.d';

/**
 * Grace window before the hovered trunk "unhovers". The branch menu lives at
 * dock level (outside the scrollable frame strip), so the pointer must cross a
 * small gap between the thumbnail and the menu; the delay keeps the menu open
 * during that crossing instead of closing on the thumbnail's mouseleave.
 */
const BRANCH_MENU_HOVER_GRACE_MS = 150;

/**
 * useTabDock: Unified hook for bottom operation bar (State + Geometry + Commands).
 */
export const useTabDock = () => {
  const { state, activeFrame } = useEditorState();
  const { actions } = useEditorServices();
  const [selfConfig] = usePluginSelfConfig<P.TabDockConfig>();
  const { configUpdateCmd, openSettingsCmd } = usePluginCommands<TabDockCommandsMap>();

  const { frames, activeFrameId } = state;
  const config = selfConfig;

  // 1. Hover & Drag Volatile State
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isPhysicalExpanded, setIsPhysicalExpanded] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const [hoveredTrunkId, setHoveredTrunkId] = useState<string | null>(null);

  const expandTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hoverGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isReorderingRef = useRef(false);
  // Set when a thumbnail reorder drag starts; the thumbnail's onClick consumes
  // and resets it so releasing a drag never also switches frames.
  const suppressClickRef = useRef(false);

  // Sync expanded state with hover/drag
  useEffect(() => {
    if (isHovered || isDragging || isReordering) {
      if (expandTimeoutRef.current) clearTimeout(expandTimeoutRef.current);
      setIsPhysicalExpanded(true);
    } else {
      expandTimeoutRef.current = setTimeout(() => {
        setIsPhysicalExpanded(false);
      }, 200);
    }
    return () => {
      if (expandTimeoutRef.current) clearTimeout(expandTimeoutRef.current);
    };
  }, [isHovered, isDragging, isReordering]);

  // Clear the pending hover close when the hook unmounts.
  useEffect(() => () => {
    if (hoverGraceTimerRef.current) clearTimeout(hoverGraceTimerRef.current);
  }, []);

  const hoverTrunk = useCallback((id: string) => {
    if (isReorderingRef.current) return;
    if (hoverGraceTimerRef.current) {
      clearTimeout(hoverGraceTimerRef.current);
      hoverGraceTimerRef.current = null;
    }
    setHoveredTrunkId(id);
  }, []);

  const unhoverTrunk = useCallback(() => {
    // During a thumbnail drag the pointer may slide off the dragged item; the
    // trunk must keep its hover (scale) until the drag settles.
    if (isReorderingRef.current) return;
    if (hoverGraceTimerRef.current) clearTimeout(hoverGraceTimerRef.current);
    hoverGraceTimerRef.current = setTimeout(() => {
      hoverGraceTimerRef.current = null;
      setHoveredTrunkId(null);
    }, BRANCH_MENU_HOVER_GRACE_MS);
  }, []);

  const setReordering = useCallback((value: boolean) => {
    isReorderingRef.current = value;
    setIsReordering(value);
    if (value) {
      // Freeze whichever trunk is currently hovered so the dragged thumbnail
      // stays scaled for the whole drag. Only the pending hover close is
      // cancelled (it would otherwise drop the state mid-drag); the branch
      // menu itself is hidden while reordering via `state.isReordering`.
      if (hoverGraceTimerRef.current) {
        clearTimeout(hoverGraceTimerRef.current);
        hoverGraceTimerRef.current = null;
      }
      suppressClickRef.current = true;
    }
  }, []);

  // 2. DFS Tree Calculation
  const activeTrunkId = activeFrame?.parentId || activeFrame?.id;
  const allOrderedFrames = useMemo(
    () => frames.order.map((id) => frames.byId[id]).filter(Boolean),
    [frames],
  );
  const trunkFrames = useMemo(
    () => allOrderedFrames.filter((f) => !f.parentId),
    [allOrderedFrames],
  );
  const branchesByParent = useMemo(
    () => calculateBranches(allOrderedFrames, trunkFrames),
    [allOrderedFrames, trunkFrames],
  );

  // 3. Snap & Position Logic (Geometry)
  const initialPos = useMemo(() => calculateDockPosition(config), [config]);

  // 4. Semantic Action Handlers
  return useMemo(() => ({
    state: {
      config,
      isHovered,
      isDragging,
      isReordering,
      isPhysicalExpanded,
      hoveredTrunkId,
      activeTrunkId,
      trunkFrames,
      branchesByParent,
      initialPos,
      framesCount: frames.order.length,
      activeFrameId,
      showFull: isPhysicalExpanded || isDragging || frames.order.length <= 1 || config.showProps
    },
    updateConfig: (patch: Partial<P.TabDockConfig>) => configUpdateCmd?.execute(patch),
    switchFrame: (id: string) => actions.switchFrame(id),
    removeFrame: (id: string) => actions.adv.frame.remove.execute(id),
    handleReorder: (newTrunkOrder: typeof trunkFrames) => {
      actions.setFrames(flattenReorderedFrames(allOrderedFrames, newTrunkOrder));
    },
    openSettings: () => openSettingsCmd?.execute(),
    handleDockDragEnd: (rect: DOMRect, parentRect: { left: number; top: number }) => {
      setIsDragging(false);
      configUpdateCmd?.execute({
        position: { x: rect.left - parentRect.left, y: rect.top - parentRect.top }
      });
    },
    setIsHovered,
    setIsDragging,
    setReordering,
    hoverTrunk,
    unhoverTrunk,
    suppressClickRef,
  }), [
    actions, config, isHovered, isDragging, isReordering, isPhysicalExpanded,
    hoveredTrunkId, activeTrunkId, trunkFrames, branchesByParent, initialPos,
    frames.order.length, activeFrameId, allOrderedFrames,
    configUpdateCmd, openSettingsCmd, setReordering, hoverTrunk, unhoverTrunk
  ]);
};

// ---------------------------------------------------------------------------
// Power monitor (used by MetricsHUD)
// ---------------------------------------------------------------------------

/**
 * Power monitor: qualitative main-thread load (LOW / MOD / HIGH).
 *
 * Principle: main-thread busy% = 100 - idle%. Idle time is measured with
 * requestIdleCallback, so it reflects load from ANY source (no instrumentation).
 *
 * Duty-cycled sampling driven by the caller's existing 1s timer (no new timers):
 *   tick % 3 == 0 -> start sampling (rIC chain)
 *   tick % 3 == 1 -> stop sampling, evaluate busy%
 *   tick % 3 == 2 -> sleep
 *
 * Fallback when requestIdleCallback is unavailable (Safari): slow-frame ratio
 * fed by noteFrame(); may under-report (flagged via `degraded`).
 */

export type PowerLevel = 'LOW' | 'MOD' | 'HIGH';

export interface PowerState {
  level: PowerLevel;
  /** Last measured main-thread busy percentage (0-100), null before first sample. */
  busy: number | null;
  /** True when using the frame-time fallback (may under-report). */
  degraded: boolean;
}

export interface PowerMonitor {
  /** Call once per second from the HUD's existing 1s timer. */
  tick(): PowerState;
  /** Call from an existing rAF loop with the frame interval (ms). Fallback only. */
  noteFrame(dtMs: number): void;
  dispose(): void;
}

const MOD_THRESHOLD = 30;
const HIGH_THRESHOLD = 60;
const SLOW_FRAME_MS = 25;
const CONFIRM_SAMPLES = 2;

const POWER_RANK: Record<PowerLevel, number> = { LOW: 0, MOD: 1, HIGH: 2 };

function classifyPower(busy: number): PowerLevel {
  if (busy >= HIGH_THRESHOLD) return 'HIGH';
  if (busy >= MOD_THRESHOLD) return 'MOD';
  return 'LOW';
}

export function createPowerMonitor(): PowerMonitor {
  const hasRic =
    typeof window !== 'undefined' &&
    typeof window.requestIdleCallback === 'function';

  let phase = 0;
  let sampling = false;
  let ricHandle = 0;
  let idleMs = 0;
  let lastEnd = 0;
  let t0 = 0;
  let frames = 0;
  let slowFrames = 0;

  let level: PowerLevel = 'LOW';
  let busy: number | null = null;
  let upStreak = 0;
  let downStreak = 0;

  const onIdle = (deadline: IdleDeadline) => {
    const now = performance.now();
    const end = now + deadline.timeRemaining();
    // Same idle period can fire several callbacks; count each period once.
    if (end - lastEnd > 1) {
      idleMs += end - now;
      lastEnd = end;
    }
    if (sampling) ricHandle = window.requestIdleCallback(onIdle);
  };

  const startSampling = () => {
    sampling = true;
    idleMs = 0;
    lastEnd = 0;
    frames = 0;
    slowFrames = 0;
    t0 = performance.now();
    if (hasRic) ricHandle = window.requestIdleCallback(onIdle);
  };

  const stopSampling = () => {
    sampling = false;
    if (hasRic && ricHandle) window.cancelIdleCallback(ricHandle);
    ricHandle = 0;
  };

  const evaluate = () => {
    const elapsed = performance.now() - t0;
    if (elapsed <= 0) return;
    let measured: number;
    if (hasRic) {
      measured = 100 - (Math.min(idleMs, elapsed) / elapsed) * 100;
    } else {
      if (frames === 0) return;
      measured = (slowFrames / frames) * 100;
    }
    busy = Math.round(measured);

    // Debounce: require consecutive samples before changing level.
    const candidate = classifyPower(measured);
    if (POWER_RANK[candidate] > POWER_RANK[level]) {
      downStreak = 0;
      if (++upStreak >= CONFIRM_SAMPLES) {
        level = candidate;
        upStreak = 0;
      }
    } else if (POWER_RANK[candidate] < POWER_RANK[level]) {
      upStreak = 0;
      if (++downStreak >= CONFIRM_SAMPLES) {
        level = candidate;
        downStreak = 0;
      }
    } else {
      upStreak = 0;
      downStreak = 0;
    }
  };

  const state: PowerState = { level, busy, degraded: !hasRic };

  return {
    tick() {
      if (typeof document !== 'undefined' && document.hidden) {
        // Background tab: timers/rIC are throttled, data would be meaningless.
        if (sampling) stopSampling();
        phase = 0;
      } else {
        const step = phase % 3;
        if (step === 0) startSampling();
        else if (step === 1 && sampling) {
          stopSampling();
          evaluate();
        }
        phase = (phase + 1) % 3;
      }
      state.level = level;
      state.busy = busy;
      return state;
    },
    noteFrame(dtMs: number) {
      if (!sampling || hasRic) return;
      frames++;
      if (dtMs > SLOW_FRAME_MS) slowFrames++;
    },
    dispose() {
      stopSampling();
    },
  };
}

