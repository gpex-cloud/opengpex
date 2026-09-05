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
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import { VolatileState, Frame, CameraState, Layer } from '@opengpex/editor/core/types';
import { markerToSvg } from '@opengpex/editor/core/engine/rendering/shared/markerPainter';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import { getMarkerPreview, getMarkerPreviewVersion } from './interactions';

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
      // A draw/move drag owns the cursor; skip to prevent oscillation.
      if (isInteractingRef.current) return;

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

/**
 * useMarkerPreviewFastSync: drives the drag-preview SVG group.
 *
 * Follows the camera via CSS transform and re-renders the SVG content only when
 * the module-level preview version changes (same dirty-check idea as
 * BrushOverlay's useStrokePreviewFastSync). The preview SVG itself is produced
 * by core `markerToSvg`, guaranteeing pixel parity with the final rasterized
 * output (§6.6).
 */
export function useMarkerPreviewFastSync(
  containerRef: React.RefObject<HTMLDivElement | null>,
  groupRef: React.RefObject<SVGGElement | null>,
) {
  const lastVersionRef = useRef<number>(-1);
  const lastCamRef = useRef<{ x: number; y: number; k: number } | null>(null);

  useFastSync(containerRef, true, (_v: VolatileState, _f: Frame, cam: CameraState) => {
    const el = containerRef.current;
    const g = groupRef.current;
    if (!el || !g) return;

    // Camera follow (canvas-local origin → screen).
    const camChanged = !lastCamRef.current ||
      lastCamRef.current.x !== cam.x ||
      lastCamRef.current.y !== cam.y ||
      lastCamRef.current.k !== cam.k;
    if (camChanged) {
      lastCamRef.current = { x: cam.x, y: cam.y, k: cam.k };
      el.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
    }

    // Dirty-check the preview store.
    const version = getMarkerPreviewVersion();
    if (version === lastVersionRef.current) return;
    lastVersionRef.current = version;

    const preview = getMarkerPreview();
    if (!preview) {
      g.innerHTML = '';
      g.removeAttribute('transform');
      return;
    }

    // Position the SVG fragment at the marker's canvas-local top-left, then let
    // markerToSvg draw in layer-local coordinates (0,0 = bounding top-left).
    g.setAttribute('transform', `translate(${preview.topLeftLocal.x}, ${preview.topLeftLocal.y})`);
    g.innerHTML = markerToSvg(preview.markerData, preview.bounding);
  }, { throttleHz: 60 });
}

// ─── useMarkerSelectionFastSync ────────────────────────────────────────────────

/**
 * useMarkerSelectionFastSync: positions the selection box (outline + resize
 * handles) over the active marker layer, following the camera and any live
 * move/resize at 60fps.
 *
 * Mirrors TextOverlay's editor fast-sync: reads the fast-track-merged frame so
 * bounding/cx/cy written by the resize transaction are reflected on the next
 * ticker frame without a React re-render. The box is a screen-space div (its
 * children counter-scale to a constant screen size via the returned camera k).
 *
 * Returns the active marker layer id (or null) so the component can mount/unmount
 * the handles, and a ref to publish the current camera scale for the handles.
 */
export function useMarkerSelectionFastSync(
  boxRef: React.RefObject<HTMLDivElement | null>,
  layerId: string | null,
) {
  const { geometry } = useEditorServices();

  useFastSync(boxRef, !!layerId, (_v: VolatileState, f: Frame, cam: CameraState) => {
    const el = boxRef.current;
    if (!el || !layerId) return;

    const layer = f.layers.byId[layerId];
    if (!layer || layer.type !== 'vector' || !layer.markerData) {
      el.style.display = 'none';
      return;
    }

    // Project the bounding box through the layer's FULL world matrix (includes
    // layer.rotation/flip — canvas rotation is baked into the layer pose by
    // transformFrame, which changes rotation but NOT bounding.w/h) composed with
    // the camera matrix. Same pipeline as LayerOverlay, so the box self-rotates
    // to match the marker. The parent container's useOverlayRotationSync adds the
    // smooth rotation TWEEN on top (LayerOverlay uses both together).
    const worldMatrix = geometry.transform.getLayerWorldMatrix(layer);
    const viewMatrix = geometry.camera.getCameraMatrix(f, cam);
    const screenMatrix = viewMatrix.multiply(worldMatrix);

    // Bounding box is layer-local (top-left at 0,0), so no visibleShape offset.
    const w = layer.bounding.w;
    const h = layer.bounding.h;
    const matrix = { ...screenMatrix, w, h };
    const { scaleX, scaleY } = geometry.transform.decomposeMatrix(matrix);

    // Split scale (→ width/height) from pure rotation/flip (→ CSS matrix), so the
    // 1px outline and handle dots keep constant screen size regardless of zoom.
    const pureA = matrix.a / (scaleX || 0.001);
    const pureB = matrix.b / (scaleX || 0.001);
    const pureC = matrix.c / (scaleY || 0.001);
    const pureD = matrix.d / (scaleY || 0.001);

    el.style.display = 'block';
    el.style.width = `${w * scaleX}px`;
    el.style.height = `${h * scaleY}px`;
    el.style.transform = `matrix(${pureA}, ${pureB}, ${pureC}, ${pureD}, ${matrix.tx}, ${matrix.ty})`;
  }, { throttleHz: 60 });
}
