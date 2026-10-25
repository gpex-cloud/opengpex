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
import { useEditorState, useEditorServices, usePluginConfig, useVolatileInteraction } from '@opengpex/editor/core/context';
import { useMosaicCursorFastSync } from './useFastSync';
import { CraftDrawerAPI, MOSAIC_SIZE_PRESETS } from '../../drawers/CraftDrawer/protocols';
import type { CraftDrawerConfig } from '../../drawers/CraftDrawer/protocols';

// ─── useMosaicOverlayState ─────────────────────────────────────────────────────

/**
 * useMosaicOverlayState: Hook for MosaicOverlay main component state
 *
 * Manages cursor hiding (base cursor 'none') in mosaic mode
 * and Escape exit logic. Returns whether in active mosaic mode.
 */
export function useMosaicOverlayState() {
  const { state, activeFrame } = useEditorState();
  const { actions } = useEditorServices();

  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft] as string | null;
  const isMosaicMode = activeCraft === 'mosaic';

  // Registers the 'none' base cursor so the DOM circle replaces the system
  // cursor; unregistering is owner-scoped to this tool.
  useEffect(() => {
    if (!isMosaicMode) return;
    actions.fast.cursor.register('mosaic', 'none');
    return () => {
      actions.fast.cursor.register('mosaic', null);
    };
  }, [isMosaicMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key exits mosaic mode
  useEffect(() => {
    if (!isMosaicMode) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        actions.executeCommand(CraftDrawerAPI.commands.deactivate.uid);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isMosaicMode, actions]);

  return {
    isMosaicMode,
    activeCraft,
    activeFrame,
  };
}

// ─── useMosaicCursorTracking ───────────────────────────────────────────────────

/**
 * useMosaicCursorTracking: 60fps mouse position tracking + camera.k real-time synchronization
 */
export function useMosaicCursorTracking(
  cursorRef: React.RefObject<HTMLDivElement | null>,
  isActive: boolean,
  brushDiameter: number,
) {
  const pointerRef = useRef({ x: 0, y: 0 });
  const rafIdRef = useRef<number>(0);
  const isVisibleRef = useRef(false);
  const springMetaRef = useRef(false);
  const springChannels = useVolatileInteraction('springChannels');

  // Cmd spring key state, read by the tracking loop below: while held the
  // press routes away from this tool, so the ring must not REVEAL itself.
  // The hide half (muting a visible ring while Cmd is down, restoring on
  // release) is infrastructure: SpringKeyManager mirrors the flag onto
  // <html data-spring-meta> and one global CSS rule mutes every element
  // tagged `data-cursor-indicator` — no per-tool DOM write here.
  useLayoutEffect(() => {
    springMetaRef.current = springChannels.meta;
  }, [springChannels]);

  // Real-time synchronization of cursor size
  useMosaicCursorFastSync(cursorRef, isActive, brushDiameter);

  // Pointer position tracking
  useEffect(() => {
    if (!isActive) {
      const el = cursorRef.current;
      if (el) {
        el.style.opacity = '0';
      }
      isVisibleRef.current = false;
      return;
    }

    const handlePointerMove = (e: PointerEvent) => {
      const viewportContainer = cursorRef.current?.closest('.editor-viewport-container');
      if (!viewportContainer) return;

      const rect = viewportContainer.getBoundingClientRect();
      pointerRef.current.x = e.clientX - rect.left;
      pointerRef.current.y = e.clientY - rect.top;

      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = 0;
          const el = cursorRef.current;
          if (!el) return;

          el.style.transform = `translate(${pointerRef.current.x}px, ${pointerRef.current.y}px)`;

          if (!isVisibleRef.current && !springMetaRef.current) {
            el.style.opacity = '1';
            isVisibleRef.current = true;
          }
        });
      }
    };

    const handlePointerLeave = () => {
      const el = cursorRef.current;
      if (el) {
        el.style.opacity = '0';
        isVisibleRef.current = false;
      }
    };

    const viewportContainer = cursorRef.current?.closest('.editor-viewport-container');
    if (viewportContainer) {
      viewportContainer.addEventListener('pointermove', handlePointerMove as EventListener);
      viewportContainer.addEventListener('pointerleave', handlePointerLeave as EventListener);
    }

    return () => {
      if (viewportContainer) {
        viewportContainer.removeEventListener('pointermove', handlePointerMove as EventListener);
        viewportContainer.removeEventListener('pointerleave', handlePointerLeave as EventListener);
      }
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    };
  }, [isActive, cursorRef]);

  // Alt modifier key listening: control visibility of "+" force-new-layer badge
  useEffect(() => {
    if (!isActive) return;

    const setBadgeVisibility = (visible: boolean) => {
      const el = cursorRef.current;
      if (!el) return;
      const badge = el.querySelector('[data-badge="new-layer"]') as HTMLElement;
      if (badge) {
        badge.style.opacity = visible ? '1' : '0';
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        setBadgeVisibility(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        setBadgeVisibility(false);
      }
    };

    const handleBlur = () => {
      setBadgeVisibility(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [isActive, cursorRef]);
}

// ─── useMosaicParams ───────────────────────────────────────────────────────────

/**
 * useMosaicParams: Reads current mosaic parameters
 */
export function useMosaicParams() {
  const [craftConfig] = usePluginConfig<CraftDrawerConfig>(CraftDrawerAPI.configKey);
  const sizePreset = craftConfig?.mosaicSizePreset ?? 'M';
  const presetData = MOSAIC_SIZE_PRESETS[sizePreset as keyof typeof MOSAIC_SIZE_PRESETS] ?? MOSAIC_SIZE_PRESETS['M'];

  return {
    sizePreset,
    brushDiameter: presetData.brushDiameter,
    blockSize: presetData.blockSize,
  };
}
