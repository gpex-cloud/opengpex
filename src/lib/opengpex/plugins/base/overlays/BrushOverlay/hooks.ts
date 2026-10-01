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

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useEditorState, useEditorServices, usePluginConfig } from '@opengpex/editor/core/context';
import type { ColorValue } from '@opengpex/editor/core/engine/color';
import { CraftDrawerAPI, type CraftDrawerConfig } from '../../drawers/CraftDrawer/protocols';
import { ColorOptionsAPI } from '../../options/ColorOptions/protocols';
import { useBrushCursorFastSync } from './useFastSync';

/** Only used when CraftDrawer has no persisted size yet (mirrors interactions.ts). */
const FALLBACK_BRUSH_SIZE = 12;

// ─── useBrushOverlayState ─────────────────────────────────────────────────────

/**
 * useBrushOverlayState: reads whether the brush is the active craft,
 * which drives the overlay's early return (it renders nothing otherwise).
 */
export function useBrushOverlayState() {
  const { state, activeFrame } = useEditorState();
  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft] as string | null;
  return { isBrushMode: activeCraft === 'brush', activeCraft, activeFrame };
}

// ─── useBrushParams / useBrushColor ──────────────────────────────────────────

/**
 * Paint parameters for the CURSOR ring. The gesture itself re-reads the same
 * config in `interactions.ts` (outside React), so these two must stay in sync.
 */
export function useBrushParams() {
  const [craftConfig] = usePluginConfig<CraftDrawerConfig>(CraftDrawerAPI.configKey);
  return {
    brushSize: craftConfig?.brushSize ?? FALLBACK_BRUSH_SIZE,
    brushOpacity: craftConfig?.brushOpacity ?? 100,
    brushHardness: craftConfig?.brushHardness ?? 80,
  };
}

/** Foreground colour as a CSS string, for the cursor ring's fill preview only. */
export function useBrushColor(): string {
  const [colorConfig] = usePluginConfig<{ pendingColor?: ColorValue }>(ColorOptionsAPI.configKey);
  return colorConfig?.pendingColor?.hex || '#FFFFFF';
}

// ─── useBrushCursorTracking ───────────────────────────────────────────────────

/**
 * useBrushCursorTracking: 60fps pointer following for the brush ring.
 *
 * Position comes from a `pointermove` listener coalesced into a rAF, size comes
 * from the volatile ticker (`useBrushCursorFastSync`, camera.k). Both write
 * `style` directly — the ring never re-renders through React.
 */
export function useBrushCursorTracking(
  cursorRef: React.RefObject<HTMLDivElement | null>,
  isActive: boolean,
  brushSize: number,
) {
  const pointerRef = useRef({ x: 0, y: 0 });
  const rafIdRef = useRef<number>(0);
  const isVisibleRef = useRef(false);

  useBrushCursorFastSync(cursorRef, isActive, brushSize);

  useEffect(() => {
    if (!isActive) {
      const el = cursorRef.current;
      if (el) el.style.opacity = '0';
      isVisibleRef.current = false;
      return;
    }

    const viewportContainer = cursorRef.current?.closest('.editor-viewport-container');
    if (!viewportContainer) return;

    const handlePointerMove = (ev: Event) => {
      const e = ev as PointerEvent;
      const rect = viewportContainer.getBoundingClientRect();
      pointerRef.current.x = e.clientX - rect.left;
      pointerRef.current.y = e.clientY - rect.top;

      if (rafIdRef.current) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0;
        const el = cursorRef.current;
        if (!el) return;
        el.style.transform = `translate(${pointerRef.current.x}px, ${pointerRef.current.y}px)`;
        if (!isVisibleRef.current) {
          el.style.opacity = '1';
          isVisibleRef.current = true;
        }
      });
    };

    const handlePointerLeave = () => {
      const el = cursorRef.current;
      if (el) el.style.opacity = '0';
      isVisibleRef.current = false;
    };

    viewportContainer.addEventListener('pointermove', handlePointerMove);
    viewportContainer.addEventListener('pointerleave', handlePointerLeave);

    return () => {
      viewportContainer.removeEventListener('pointermove', handlePointerMove);
      viewportContainer.removeEventListener('pointerleave', handlePointerLeave);
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    };
  }, [isActive, cursorRef]);
}

// ─── useBrushToolLifecycle ────────────────────────────────────────────────────

/**
 * useBrushToolLifecycle: cursor ownership + Escape handling for the vector brush.
 *
 * CURSOR: the native cursor is hidden (`'none'`) for the whole session, because
 * the overlay draws its own size-accurate ring (with a crosshair at its centre).
 *
 * ESCAPE: mid-stroke, the viewport-level Esc handler cancels the gesture
 * (`dispatcher.cancelAll()` → our `onCancel`, which aborts the transaction and
 * drops the half-drawn layer) and we stay in the tool; idle, Esc leaves the
 * tool through CraftDrawer's own command, respecting signal ownership.
 *
 * Called unconditionally before the overlay's early return (hook-order rule),
 * so every effect gates on `isBrushMode` itself and cleans up on tool switch.
 */
export function useBrushToolLifecycle(isBrushMode: boolean) {
  const { state } = useEditorState();
  const { actions } = useEditorServices();

  const isInteractingRef = useRef(false);
  useLayoutEffect(() => { isInteractingRef.current = !!state.interaction.isInteracting; });

  // ─── Cursor: hide the native pointer, the ring replaces it ─────────────
  useEffect(() => {
    if (!isBrushMode) return;
    actions.fast.setCursor('none');
    return () => {
      // Only release what we set — another tool may already own the cursor.
      if (actions.fast.getCursor() === 'none') actions.fast.setCursor(null);
    };
  }, [isBrushMode, actions]);

  // ─── Escape: cancel in-progress stroke / else exit the tool ────────────
  useEffect(() => {
    if (!isBrushMode) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isInteractingRef.current) return; // viewport-level cancelAll owns this

      e.preventDefault();
      e.stopPropagation();
      actions.executeCommand(CraftDrawerAPI.commands.deactivate.uid);
      actions.fast.setCursor(null);
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isBrushMode, actions]);

  // Safety net: never leave a hidden cursor behind on unmount.
  useEffect(() => {
    return () => {
      if (actions.fast.getCursor() === 'none') actions.fast.setCursor(null);
    };
  }, [actions]);
}
