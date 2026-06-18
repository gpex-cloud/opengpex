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

import { useEffect, useRef } from 'react';
import { useEditorState, useEditorServices, usePluginConfig } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { VolatileState, Frame, CameraState } from '@opengpex/editor/core/types';
import { CRAFT_DRAWER_SIGNAL_ACTIVE_CRAFT, CRAFT_DRAWER_CMD_DEACTIVATE_CRAFT, CRAFT_DRAWER_CONFIG_KEY } from '../../drawers/CraftDrawer/protocols';
import { COLOR_OPTIONS_CONFIG_KEY } from '../../options/ColorOptions/protocols';
import type { CraftDrawerConfig } from '../../drawers/CraftDrawer/protocols';
import { DEFAULT_BRUSH_SIZE } from './protocols';

// ─── useBrushOverlayState ──────────────────────────────────────────────────────

/**
 * useBrushOverlayState: Hook for BrushOverlay main component state
 *
 * Manages cursor hiding (cursorOverride: 'none') in brush/eraser mode
 * and Escape exit logic. Returns whether in active brush/eraser mode.
 */
export function useBrushOverlayState() {
  const { state, activeFrame } = useEditorState();
  const { actions } = useEditorServices();

  const activeCraft = state.interaction.signals[CRAFT_DRAWER_SIGNAL_ACTIVE_CRAFT] as string | null;
  const isBrushMode = activeCraft === 'brush' || activeCraft === 'eraser' || activeCraft === 'restore';

  // Sets/clears cursorOverride: 'none' to hide system cursor (replaced by DOM circle)
  useEffect(() => {
    if (isBrushMode) {
      // Hide system cursor, use custom DOM cursor instead
      actions.setInteraction({ cursorOverride: 'none' });
    } else {
      // When exiting brush mode, restore default if current cursor is 'none' (set by this plugin)
      if (state.interaction.cursorOverride === 'none') {
        actions.setInteraction({ cursorOverride: null });
      }
    }
  }, [isBrushMode, actions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key exits brush/eraser mode (via CraftDrawer's deactivate command, following cross-plugin boundaries)
  useEffect(() => {
    if (!isBrushMode) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Deactivate tool via CraftDrawer's command system (following signal ownership boundaries)
        actions.executeCommand(CRAFT_DRAWER_CMD_DEACTIVATE_CRAFT);
        actions.setInteraction({ cursorOverride: null });
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isBrushMode, actions]);

  // Restore cursor on component unmount
  useEffect(() => {
    return () => {
      if (state.interaction.cursorOverride === 'none') {
        actions.setInteraction({ cursorOverride: null });
      }
    };
  }, [actions]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    isBrushMode,
    activeCraft,
    activeFrame,
  };
}

// ─── useBrushCursorTracking ────────────────────────────────────────────────────

/**
 * useBrushCursorTracking: 60fps mouse position tracking + camera.k real-time synchronization
 *
 * Updates cursor DOM position in real time via pointermove event listener,
 * and synchronizes cursor size in real time via useFastSync Ticker (follows camera.k zoom).
 * Both directly manipulate the DOM (bypassing React) to achieve zero-redraw cursor following.
 *
 * @param cursorRef Cursor DOM element reference
 * @param isActive Whether tracking is active
 * @param brushSize Current brush size (pixels)
 */
export function useBrushCursorTracking(
  cursorRef: React.RefObject<HTMLDivElement | null>,
  isActive: boolean,
  brushSize: number = DEFAULT_BRUSH_SIZE,
) {
  // Store latest mouse screen coordinates (relative to viewport container)
  const pointerRef = useRef({ x: 0, y: 0 });
  const rafIdRef = useRef<number>(0);
  const isVisibleRef = useRef(false);
  const lastCameraKRef = useRef<number>(1);

  // ─── Fast track: camera.k real-time synchronization of cursor size ───────────────────────────────────────
  useFastSync(cursorRef, isActive, (_v: VolatileState, _f: Frame, cam: CameraState) => {
    const el = cursorRef.current;
    if (!el) return;

    const cameraK = cam.k;
    if (Math.abs(cameraK - lastCameraKRef.current) < 0.001) return; // Skip if no change
    lastCameraKRef.current = cameraK;

    // Calculate new screen diameter
    const screenDiameter = Math.max(brushSize * cameraK, 4);
    const halfSize = screenDiameter / 2;

    // Update margin (align cursor center with pointer position)
    el.style.marginLeft = `-${halfSize}px`;
    el.style.marginTop = `-${halfSize}px`;

    // Update dimensions of all child elements
    const children = el.children;
    // Outer ring
    if (children[0]) {
      (children[0] as HTMLElement).style.width = `${screenDiameter}px`;
      (children[0] as HTMLElement).style.height = `${screenDiameter}px`;
    }
    // Inner ring
    if (children[1]) {
      (children[1] as HTMLElement).style.width = `${screenDiameter - 2}px`;
      (children[1] as HTMLElement).style.height = `${screenDiameter - 2}px`;
    }
    // Color fill (if present)
    if (children[2] && (children[2] as HTMLElement).classList.contains('rounded-full')) {
      (children[2] as HTMLElement).style.width = `${screenDiameter - 4}px`;
      (children[2] as HTMLElement).style.height = `${screenDiameter - 4}px`;
      (children[2] as HTMLElement).style.display = screenDiameter > 6 ? '' : 'none';
    }
    // Crosshair (last two)
    const crossV = el.querySelector('[data-cross="v"]') as HTMLElement;
    const crossH = el.querySelector('[data-cross="h"]') as HTMLElement;
    if (crossV) {
      crossV.style.left = `${halfSize - 0.5}px`;
      crossV.style.top = `${halfSize - 3}px`;
    }
    if (crossH) {
      crossH.style.left = `${halfSize - 3}px`;
      crossH.style.top = `${halfSize - 0.5}px`;
    }
  });

  // ─── Pointer position tracking ─────────────────────────────────────────────────────────
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

          if (!isVisibleRef.current) {
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

  // ─── Cmd/Ctrl modifier key listening: control visibility of "+" new layer badge ────────────────────────────
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
      if (e.key === 'Meta' || e.key === 'Control') {
        setBadgeVisibility(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') {
        setBadgeVisibility(false);
      }
    };

    // Also clear badge on window blur (prevents residual Meta key state after switching windows)
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

// ─── useBrushParams (read) ─────────────────────────────────────────────────────

/**
 * useBrushParams: Reads current brush parameters
 *
 * Reads brush parameters from CraftDrawer's pluginConfig, returning currently active size/opacity/hardness.
 */
export function useBrushParams() {
  const [craftConfig] = usePluginConfig<CraftDrawerConfig>(CRAFT_DRAWER_CONFIG_KEY);

  const brushSize = craftConfig?.brushSize ?? DEFAULT_BRUSH_SIZE;
  const brushOpacity = craftConfig?.brushOpacity ?? 100;
  const brushHardness = craftConfig?.brushHardness ?? 80;

  return { brushSize, brushOpacity, brushHardness };
}

// ─── useBrushColor ─────────────────────────────────────────────────────────────

/**
 * useBrushColor: Reads current brush color
 *
 * Reads pendingColor from ColorOptions' pluginConfig as the brush color.
 */
export function useBrushColor(): string {
  const [colorConfig] = usePluginConfig<{ pendingColor?: string }>(COLOR_OPTIONS_CONFIG_KEY);
  return colorConfig?.pendingColor || '#FFFFFF';
}
