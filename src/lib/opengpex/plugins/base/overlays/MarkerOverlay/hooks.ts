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
import { MARKER_CURSOR } from '@opengpex/editor/icons';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import type { CraftDrawerConfig } from '../../drawers/CraftDrawer/protocols';
import { resolveMarkerToolState, type MarkerToolState } from './protocols';

// Fast-track (Ticker/DOM) synchronizers live in the sibling `useFastSync.ts`,
// per the overlay convention (Brush/Clip/Layer/Text): useMarkerPreviewFastSync,
// useMarkerSelectionFastSync.

/**
 * useMarkerOverlayState: reads whether the marker tool is active (drives the
 * overlay's mount/unmount so it does nothing outside marker mode).
 */
export function useMarkerOverlayState() {
  const { state, activeLayer } = useEditorState();
  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft] as string | null;
  const isMarkerMode = activeCraft === 'marker';
  // The armed sub-type (what the next drag draws) — CraftDrawer owns it; the
  // overlay only reads it to derive the selection's tool state.
  const armedKind = (
    state.pluginConfig[CraftDrawerAPI.configKey] as Partial<CraftDrawerConfig> | undefined
  )?.activeMarkerKind;
  const toolState = resolveMarkerToolState(activeLayer, armedKind);
  return { isMarkerMode, activeCraft, armedKind, toolState };
}

// ─── useMarkerToolLifecycle ────────────────────────────────────────────────────

/**
 * useMarkerToolLifecycle: cursor feedback + Escape handling for the marker tool.
 *
 * Cursor: while the tool is active the base cursor is `crosshair`; when
 * the pointer hovers an existing marker layer it switches to `move` (matching
 * MarkerMoveHandler winning the hit). During an active drag (draw or move) the
 * cursor is owned by the interaction handler (draw keeps `crosshair`, move sets
 * `grabbing`), so hover recomputation is skipped to avoid flicker — same guard
 * as ClipOverlay's `useClipCursor`.
 *
 * Escape: if a drag is in progress the viewport-level Esc handler cancels
 * it via `dispatcher.cancelAll()` (→ draw `onCancel` clears the preview) and we
 * stay in the tool; if idle, Esc deactivates the marker tool through
 * CraftDrawer's command (mirrors BrushOverlay / TextOverlay pre-edit Escape).
 *
 * Follows the always-mounted-component pattern: the hook is called before the
 * overlay's early return, gates on `isMarkerMode`, and cleans the cursor up on
 * effect teardown (tool switch / unmount).
 */
export function useMarkerToolLifecycle(isMarkerMode: boolean) {
  const { state, activeLayer } = useEditorState();
  const { actions } = useEditorServices();

  // Latest tool state for the Escape ladder (a ref so the keydown listener is
  // registered once per tool activation, not per selection/kind change).
  const toolStateRef = useRef<MarkerToolState>(resolveMarkerToolState(null, undefined));
  useLayoutEffect(() => {
    const armedKind = (
      state.pluginConfig[CraftDrawerAPI.configKey] as Partial<CraftDrawerConfig> | undefined
    )?.activeMarkerKind;
    toolStateRef.current = resolveMarkerToolState(activeLayer, armedKind);
  });

  // Track active-interaction state so cursor/Escape don't fight an ongoing drag.
  const isInteractingRef = useRef(false);
  useLayoutEffect(() => { isInteractingRef.current = !!state.interaction.isInteracting; });

  // ─── Cursor: crosshair base ─────────────────────────────────────────────
  // No hover affordance: moving an existing marker requires the Cmd spring
  // key (MarkerMoveHandler is gated to it), so the pointer stays on the
  // tool's base cursor the whole time.
  useEffect(() => {
    if (!isMarkerMode) return;

    actions.fast.cursor.register('marker', MARKER_CURSOR);

    return () => {
      // Unregister on tool switch / unmount so no stale base cursor survives
      // the marker tool; the next tool registers its own.
      actions.fast.cursor.register('marker', null);
    };
  }, [isMarkerMode, actions]);

  // ─── Escape ladder: cancel drag → leave INACTIVE → exit the tool ───────
  // Mirrors the text tool (editing → pre-edit → exit): each Esc peels one
  // level of state before leaving the tool.
  useEffect(() => {
    if (!isMarkerMode) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 1. Mid-drag: let the viewport-level Esc handler cancel the gesture
      //    (dispatcher.cancelAll → handler.onCancel); remain in the marker tool.
      if (isInteractingRef.current) return;

      e.preventDefault();
      e.stopPropagation();

      // 2. INACTIVE (a marker is selected but another kind is armed): re-arm the
      //    selected layer's kind so it returns to the ACTIVE state — the "I
      //    changed my mind about drawing a star" exit. Stay in the tool.
      const toolState = toolStateRef.current;
      if (toolState.phase === 'inactive' && toolState.selectedKind) {
        actions.executeCommand(CraftDrawerAPI.commands.setMarkerKind.uid, { kind: toolState.selectedKind });
        return;
      }

      // 3. ACTIVE or nothing selected: deactivate the marker tool via
      //    CraftDrawer's command system (respects signal ownership boundaries,
      //    same as Brush/Text).
      actions.executeCommand(CraftDrawerAPI.commands.deactivate.uid);
      actions.fast.cursor.notifyHover(null);
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isMarkerMode, actions]);

  // Safety net: drop this tool's cursor registration on unmount.
  useEffect(() => {
    return () => {
      actions.fast.cursor.register('marker', null);
      actions.fast.cursor.notifyHover(null);
    };
  }, [actions]);
}

