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

import React, {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
} from "react";

/**
 * LayoutRole: Defines how slot affects centering logic
 */
export type LayoutRole =
  | "LEFT_PUSH" // Left compression (e.g. Toolbar)
  | "RIGHT_PUSH" // Right compression (e.g. Sidebar)
  | "TOP_PUSH" // Top compression (e.g. OptionBar)
  | "BOTTOM_PUSH" // Bottom compression (e.g. Dock)
  | "OVERLAY"; // Pure overlay (does not affect centering)

export interface RegisteredSlot {
  id: string;
  role: LayoutRole;
  width: number;
  height: number;
}

export type LayoutCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export type LayoutStatus = "IDLE" | "MEASURING" | "STABLE";

interface LayoutContextValue {
  slots: Record<string, RegisteredSlot>;
  safeRect: { x: number; y: number; w: number; h: number };
  status: LayoutStatus;

  // Register/unregister slot
  registerSlot: (slot: RegisteredSlot) => void;
  unregisterSlot: (id: string) => void;

  // Four-corner blocking height (CornerBlocks)
  cornerBlocks: Record<LayoutCorner, number>;
  setCornerBlock: (corner: LayoutCorner, id: string, height: number) => void;
  clearCornerBlock: (id: string) => void;
}

const LayoutContext = createContext<LayoutContextValue | undefined>(undefined);

/**
 * LayoutProvider: Viewport layout protocol center
 */
export function LayoutProvider({
  children,
  viewportDim,
  syncKey,
}: {
  children: React.ReactNode;
  viewportDim: { w: number; h: number };
  syncKey?: unknown;
}) {
  const [slots, setSlots] = useState<Record<string, RegisteredSlot>>({});
  const [status, setStatus] = useState<LayoutStatus>("IDLE");
  const stableTimerRef = useRef<NodeJS.Timeout | null>(null);

  // CornerBlocks: { id -> { corner, height } }
  const [cornerBlockEntries, setCornerBlockEntries] = useState<
    Record<string, { corner: LayoutCorner; height: number }>
  >({});

  // 0. Rapid state derivation: When external sync key changes, enter MEASURING state immediately in [Render phase]
  // This ensures the underlying Viewport senses layout instability within the same render pass, preventing early layout jumps.
  const [lastSyncKey, setLastSyncKey] = useState(syncKey);
  if (lastSyncKey !== syncKey) {
    setLastSyncKey(syncKey);
    setStatus("MEASURING");
  }

  const [prevViewportDim, setPrevViewportDim] = useState(viewportDim);
  if (prevViewportDim.w !== viewportDim.w || prevViewportDim.h !== viewportDim.h) {
    setPrevViewportDim(viewportDim);
    if (viewportDim.w > 0 && viewportDim.h > 0) {
      setStatus("MEASURING");
    }
  }

  const registerSlot = useCallback((slot: RegisteredSlot) => {
    setSlots((prev) => {
      // Update only when size actually changes to prevent React render dead loops
      if (
        prev[slot.id]?.width === slot.width &&
        prev[slot.id]?.height === slot.height &&
        prev[slot.id]?.role === slot.role
      ) {
        return prev;
      }
      setStatus("MEASURING"); // Enter measuring state upon any changes
      return { ...prev, [slot.id]: slot };
    });
  }, []);

  const unregisterSlot = useCallback((id: string) => {
    setSlots((prev) => {
      if (!prev[id]) return prev;
      setStatus("MEASURING");
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // CornerBlock API
  const setCornerBlock = useCallback(
    (corner: LayoutCorner, id: string, height: number) => {
      setCornerBlockEntries((prev) => {
        if (prev[id]?.corner === corner && prev[id]?.height === height)
          return prev;
        return { ...prev, [id]: { corner, height } };
      });
    },
    [],
  );

  const clearCornerBlock = useCallback((id: string) => {
    setCornerBlockEntries((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // Aggregate maximum heights of the four corners
  const cornerBlocks = useMemo(() => {
    const result: Record<LayoutCorner, number> = {
      topLeft: 0,
      topRight: 0,
      bottomLeft: 0,
      bottomRight: 0,
    };
    Object.values(cornerBlockEntries).forEach(({ corner, height }) => {
      result[corner] = Math.max(result[corner], height);
    });
    return result;
  }, [cornerBlockEntries]);

  // 1. Viewport size perception: Sync into measuring state when total size changes has been moved to render phase above.

  // Stability determination logic (timing core)
  useEffect(() => {
    if (status === "MEASURING") {
      if (stableTimerRef.current) clearTimeout(stableTimerRef.current);
      stableTimerRef.current = setTimeout(() => {
        setStatus("STABLE"); // Stable state if no size changes within 300ms
      }, 300);
    }
  }, [status]);

  // Calculate Safe Rect
  const safeRect = useMemo(() => {
    let left = 0;
    let right = 0;
    let top = 0;
    let bottom = 0;

    Object.values(slots).forEach((slot) => {
      if (slot.role === "LEFT_PUSH") left = Math.max(left, slot.width);
      if (slot.role === "RIGHT_PUSH") right = Math.max(right, slot.width);
      if (slot.role === "TOP_PUSH") top = Math.max(top, slot.height);
      if (slot.role === "BOTTOM_PUSH") bottom = Math.max(bottom, slot.height);
    });

    return {
      x: left,
      y: top,
      w: Math.max(0, viewportDim.w - left - right),
      h: Math.max(0, viewportDim.h - top - bottom),
    };
  }, [slots, viewportDim]);

  const value = useMemo(
    () => ({
      slots,
      safeRect,
      status,
      registerSlot,
      unregisterSlot,
      cornerBlocks,
      setCornerBlock,
      clearCornerBlock,
    }),
    [slots, safeRect, status, registerSlot, unregisterSlot, cornerBlocks, setCornerBlock, clearCornerBlock],
  );

  return (
    <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>
  );
}

export const useLayout = () => {
  const context = useContext(LayoutContext);
  if (!context) throw new Error("useLayout must be used within LayoutProvider");
  return context;
};
