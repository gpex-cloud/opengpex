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

import { useRef, useCallback } from 'react';
import { useEditorServices, useEditorState } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { Motion } from '@opengpex/editor/core/motion';
import { Frame, CameraState, VolatileState, asLocalShape } from '@opengpex/editor/core/types';
import { LayerUtils } from '@opengpex/editor/core/layer/LayerUtils';

/**
 * useTextEditorFastSync: Text editor fast track synchronizer
 *
 * Solves two core problems:
 * 1. When canvas is panned/zoomed during editing, the editing area follows in real time (directly manipulating DOM via Ticker)
 * 2. bounding updates can be sensed in real time by gizmo (written to fast track buffer)
 */
export function useTextEditorFastSync(
  containerRef: React.RefObject<HTMLElement | null>,
  layerId: string,
  isActive: boolean
) {
  const { actions } = useEditorServices();
  const { activeFrame } = useEditorState();

  // Track cumulative bounding + position to correctly compensate cx/cy across rapid calls
  // (React state may be stale between batched updates, so we maintain our own source of truth)
  const lastStateRef = useRef<{ w: number; h: number; cx: number; cy: number } | null>(null);

  useFastSync(containerRef, isActive, (v: VolatileState, f: Frame, cam: CameraState) => {
    const el = containerRef.current;
    if (!el) return;

    // Get the latest layer from merged frame data (useFastSync has completed fast/slow track merge internally)
    const layer = f.layers.byId[layerId];
    if (!layer) return;

    const canvas = f.canvas;

    // Position of top-left corner of layer in canvas space (canvas-local, top-left origin)
    const localX = canvas.w / 2 + layer.cx - layer.bounding.w / 2;
    const localY = canvas.h / 2 + layer.cy - layer.bounding.h / 2;

    // Project to screen coordinates
    const screenX = localX * cam.k + cam.x;
    const screenY = localY * cam.k + cam.y;

    // Directly manipulate DOM to achieve 60fps sync (bypassing React)
    Motion.set(el, {
      left: screenX,
      top: screenY,
      transform: `scale(${cam.k})`,
      overwrite: true,
    });

    // Sync width and height in fixed mode to editor DOM
    const mode = layer.textData?.boxMode || 'auto';
    if (mode === 'fixed') {
      const editorEl = el.querySelector('[contenteditable]') as HTMLElement;
      if (editorEl) {
        editorEl.style.width = `${layer.bounding.w}px`;
        editorEl.style.height = `${layer.bounding.h}px`;
      }
    }
  });

  /**
   * notifyBoundingChange: When editor content size changes, synchronize writing to fast track buffer.
   * This allows LayerOverlay's gizmo to immediately perceive bounding changes via fast track.
   * Also synchronize updating visibleShape to ensure rendering pipeline doesn't crop text to old size.
   *
   * cx/cy compensation: When bounding width/height changes, cx/cy are adjusted so that the
   * top-left corner of the text box stays fixed (the box expands rightward/downward only).
   */
  const notifyBoundingChange = useCallback((w: number, h: number) => {
    if (!activeFrame) return;
    const layer = activeFrame.layers.byId[layerId];
    if (!layer) return;

    // Initialize tracking state from current layer on first call
    if (!lastStateRef.current) {
      lastStateRef.current = { w: layer.bounding.w, h: layer.bounding.h, cx: layer.cx, cy: layer.cy };
    }

    // Debounce: write only when size actually changes
    if (lastStateRef.current.w === w && lastStateRef.current.h === h) return;

    // Compute cx/cy compensation to keep top-left corner fixed
    const deltaW = w - lastStateRef.current.w;
    const deltaH = h - lastStateRef.current.h;
    const newCx = lastStateRef.current.cx + deltaW / 2;
    const newCy = lastStateRef.current.cy + deltaH / 2;

    lastStateRef.current = { w, h, cx: newCx, cy: newCy };

    // visibleShape must be expanded in sync with bounding, otherwise rendering engine will crop text to old visibleShape area
    const newVisibleShape = asLocalShape({ x: 0, y: 0, w, h });

    // Write to fast track buffer, enabling LayerOverlay gizmo to read new bounding on next frame Ticker
    const compositeKey = LayerUtils.getCompositeKey(activeFrame.id, layerId);
    actions.mutateVolatile((v: VolatileState) => {
      if (!v.buffered.layers[compositeKey]) {
        v.buffered.layers[compositeKey] = {};
      }
      v.buffered.layers[compositeKey].bounding = { w, h };
      v.buffered.layers[compositeKey].visibleShape = newVisibleShape;
      v.buffered.layers[compositeKey].cx = newCx;
      v.buffered.layers[compositeKey].cy = newCy;
    });

    // Also update slow track (Redux) to keep React state eventually consistent
    actions.updateLayer(activeFrame.id, layerId, {
      bounding: { w, h },
      visibleShape: newVisibleShape,
      cx: newCx,
      cy: newCy,
    });
  }, [activeFrame, layerId, actions]);

  return { notifyBoundingChange };
}

/**
 * useTextBoundingFastSync: Pre-editing bounding borders fast track synchronizer
 *
 * When canvas is panned/zoomed, updates screen position of all text layer borders in real time.
 * Avoids React rerendering by directly manipulating child DOM elements.
 */
export function useTextBoundingFastSync(
  containerRef: React.RefObject<HTMLElement | null>,
  isActive: boolean
) {
  useFastSync(containerRef, isActive, (_v: VolatileState, f: Frame, cam: CameraState) => {
    const el = containerRef.current;
    if (!el) return;

    const canvas = f.canvas;
    const children = el.querySelectorAll('[data-text-layer-id]') as NodeListOf<HTMLElement>;

    children.forEach((child) => {
      const layerId = child.dataset.textLayerId;
      if (!layerId) return;

      const layer = f.layers.byId[layerId];
      if (!layer || layer.type !== 'text' || !layer.visible) {
        child.style.display = 'none';
        return;
      }

      child.style.display = '';
      const localX = canvas.w / 2 + layer.cx - layer.bounding.w / 2;
      const localY = canvas.h / 2 + layer.cy - layer.bounding.h / 2;
      const screenX = localX * cam.k + cam.x;
      const screenY = localY * cam.k + cam.y;

      child.style.left = `${screenX}px`;
      child.style.top = `${screenY}px`;
      child.style.width = `${layer.bounding.w * cam.k}px`;
      child.style.height = `${layer.bounding.h * cam.k}px`;
    });
  });
}
