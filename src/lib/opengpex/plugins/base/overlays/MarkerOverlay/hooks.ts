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
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { Layer } from '@opengpex/editor/core/types';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';

// Fast-track (Ticker/DOM) synchronizers live in the sibling `useFastSync.ts`,
// per the overlay convention (Brush/Clip/Layer/Text): useMarkerPreviewFastSync,
// useMarkerSelectionFastSync.

/**
 * useMarkerOverlayState: reads whether the marker tool is active (drives the
 * overlay's mount/unmount so it does nothing outside marker mode).
 */
export function useMarkerOverlayState() {
  const { state } = useEditorState();
  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft] as string | null;
  const isMarkerMode = activeCraft === 'marker';
  return { isMarkerMode, activeCraft };
}

// ─── useMarkerToolLifecycle ────────────────────────────────────────────────────

/**
 * useMarkerToolLifecycle: cursor feedback + Escape handling for the marker tool.
 *
 * Cursor (§8.6): while the tool is active the base cursor is `crosshair`; when
 * the pointer hovers an existing marker layer it switches to `move` (matching
 * MarkerMoveHandler winning the hit). During an active drag (draw or move) the
 * cursor is owned by the interaction handler (draw keeps `crosshair`, move sets
 * `grabbing`), so hover recomputation is skipped to avoid flicker — same guard
 * as ClipOverlay's `useClipCursor`.
 *
 * Escape (§9): if a drag is in progress the viewport-level Esc handler cancels
 * it via `dispatcher.cancelAll()` (→ draw `onCancel` clears the preview) and we
 * stay in the tool; if idle, Esc deactivates the marker tool through
 * CraftDrawer's command (mirrors BrushOverlay / TextOverlay pre-edit Escape).
 *
 * Follows the always-mounted-component pattern: the hook is called before the
 * overlay's early return, gates on `isMarkerMode`, and cleans the cursor up on
 * effect teardown (tool switch / unmount).
 */
export function useMarkerToolLifecycle(isMarkerMode: boolean) {
  const { state, activeFrame } = useEditorState();
  const { actions, geometry } = useEditorServices();

  // Latest frame for the pointermove closure (avoids re-registering on change).
  const frameRef = useRef(activeFrame);
  useLayoutEffect(() => { frameRef.current = activeFrame; });

  // Track active-interaction state so cursor/Escape don't fight an ongoing drag.
  const isInteractingRef = useRef(false);
  useLayoutEffect(() => { isInteractingRef.current = !!state.interaction.isInteracting; });

  // ─── Cursor: crosshair (idle) ↔ move (hover existing marker) ───────────
  useEffect(() => {
    if (!isMarkerMode) return;

    // Base cursor for empty canvas.
    actions.fast.setCursor('crosshair');
    let currentCursor = 'crosshair';

    const onPointerMove = (ev: PointerEvent) => {
      // A draw/move/rotate drag owns the cursor; skip to prevent oscillation.
      // Check both the React-state ref AND the fast-track cursor: the fast-track
      // cursor is set synchronously by onStart before React processes the state
      // update, so it catches the first frame of interaction that React misses.
      if (isInteractingRef.current) return;
      const activeCursor = actions.fast.getCursor();
      if (activeCursor && activeCursor.startsWith('url(')) return;

      const frame = frameRef.current;
      if (!frame) return;

      const container = document.querySelector('.editor-viewport-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const vx = ev.clientX - rect.left;
      const vy = ev.clientY - rect.top;

      const cam = actions.fast.latestCamera(frame.id);
      const worldPt = geometry.space.screenToWorld(vx, vy, frame, cam);

      // Hover an existing marker layer → `move` (MarkerMoveHandler will win).
      const hits = geometry.space.pickLayersAt(worldPt, frame.layers);
      const overMarker = hits.some((l: Layer) => l.type === 'vector' && !!l.markerData);
      const desired = overMarker ? 'move' : 'crosshair';

      if (desired !== currentCursor) {
        currentCursor = desired;
        actions.fast.setCursor(desired);
      }
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      // Restore to default; the mode-level cursor logic re-applies elsewhere.
      actions.fast.setCursor(null);
    };
  }, [isMarkerMode, actions, geometry]);

  // ─── Escape: cancel in-progress draw / else exit the tool ──────────────
  useEffect(() => {
    if (!isMarkerMode) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Mid-drag: let the viewport-level Esc handler cancel the gesture
      // (dispatcher.cancelAll → handler.onCancel); remain in the marker tool.
      if (isInteractingRef.current) return;

      // Idle: deactivate the marker tool via CraftDrawer's command system
      // (respects signal ownership boundaries, same as Brush/Text).
      e.preventDefault();
      e.stopPropagation();
      actions.executeCommand(CraftDrawerAPI.commands.deactivate.uid);
      actions.fast.setCursor(null);
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isMarkerMode, actions]);

  // Safety net: clear any lingering cursor override on unmount.
  useEffect(() => {
    return () => {
      actions.fast.setCursor(null);
    };
  }, [actions]);
}

