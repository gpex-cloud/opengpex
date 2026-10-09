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
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import { Motion } from '@opengpex/editor/core/motion';
import { Frame, CameraState, VolatileState, asLocalShape } from '@opengpex/editor/core/types';
import { LayerUtils } from '@opengpex/editor/core/layer/utils';
import { compensateCenterX, compensateCenterY, reanchorCompensationBase } from './anchor';

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
  const { actions, geometry } = useEditorServices();
  const { activeFrame } = useEditorState();

  // Track cumulative bounding + position to correctly compensate cx/cy across rapid calls
  // (React state may be stale between batched updates, so we maintain our own source of truth)
  const lastStateRef = useRef<{ w: number; h: number; cx: number; cy: number } | null>(null);
  // Last cx/cy/w/h OBSERVED on the layer. Our own writes land here too (they
  // mirror lastStateRef), so only a value that differs from the previous
  // observation is a genuine EXTERNAL geometry change — a Cmd/Ctrl+Drag move
  // during editing — and must re-anchor the compensation base, otherwise the
  // next size change would write the pre-move cx/cy back (box jumps back).
  const lastLayerObservedRef = useRef<{ w: number; h: number; cx: number; cy: number } | null>(null);

  // [P0 Perf] Throttle to ~30Hz during interaction — text box positioning
  useFastSync(containerRef, isActive, (v: VolatileState, f: Frame, cam: CameraState) => {
    const el = containerRef.current;
    if (!el) return;

    // Get the latest layer from merged frame data (useFastSync has completed fast/slow track merge internally)
    const layer = f.layers.byId[layerId];
    if (!layer) return;

    // Project the container through the layer's FULL world matrix (includes
    // layer.rotation/flip — after a canvas Rotate Left/Right, transformFrame
    // bumps rotation but NOT bounding.w/h) composed with the camera matrix, so
    // the editor box self-rotates to match the layer just like LayerOverlay.
    //
    // Unlike MarkerOverlay we deliberately DO NOT split the camera scale out of
    // the matrix: the contenteditable renders text at canvas-space fontSize and
    // relies on the uniform scale(cam.k) to look right on screen. Splitting scale
    // would force fontSize × k, whose glyph wrapping no longer matches the
    // rasterizer (painter2d wraps at the zoom-independent fontSize), breaking
    // WYSIWYG. So the combined matrix carries rotation + uniform scale together,
    // and the box origin (bounding top-left = local 0,0) lands at matrix.{tx,ty}.
    const worldMatrix = geometry.transform.getLayerWorldMatrix(layer);
    const viewMatrix = geometry.camera.getCameraMatrix(f, cam);
    const screenMatrix = viewMatrix.multiply(worldMatrix);

    // Directly manipulate DOM to achieve 60fps sync (bypassing React). Position
    // is baked into the matrix translation, so left/top are pinned to 0 and the
    // transform origin is the box top-left (0,0) — the rotation pivot is already
    // encoded in the world matrix (Translate(cx,cy) × O × Translate(-w/2,-h/2)).
    Motion.set(el, {
      left: 0,
      top: 0,
      transformOrigin: '0 0',
      transform: `matrix(${screenMatrix.a}, ${screenMatrix.b}, ${screenMatrix.c}, ${screenMatrix.d}, ${screenMatrix.tx}, ${screenMatrix.ty})`,
      overwrite: true,
    });

    const currentScale = Math.hypot(screenMatrix.a, screenMatrix.b) || 1;
    el.style.setProperty('--box-corner-scale', `${1 / currentScale}`);
    el.style.setProperty('--text-caret-scale', `${1 / currentScale}`);

    // Collision-free clamp for box corners: ensure arm length never collides
    // in screen space when box is narrow or canvas is zoomed far out.
    const boxScreenW = (layer.bounding.w || 24) * currentScale;
    const boxScreenH = (layer.bounding.h || 24) * currentScale;
    const maxArmScreen = Math.min(boxScreenW * 0.36, boxScreenH * 0.36);
    const safeArmScreen = Math.max(2, Math.min(10, maxArmScreen));
    el.style.setProperty('--box-corner-arm-ratio', `${safeArmScreen / 10}`);

    // Sync width and height in fixed mode to editor DOM. These stay in canvas
    // space (px), unaffected by rotation — the matrix above handles rotation/scale.
    // The size belongs to the clip wrapper (which also owns vertical
    // alignment); the contenteditable inside stays auto-height.
    const mode = layer.textData?.boxMode || 'auto';
    if (mode === 'fixed') {
      const clipEl = el.querySelector('[data-text-clip]') as HTMLElement | null;
      if (clipEl) {
        clipEl.style.width = `${layer.bounding.w}px`;
        clipEl.style.height = `${layer.bounding.h}px`;
      }
    }
  }, { throttleHz: 60 });

  /**
   * notifyBoundingChange: When editor content size changes, synchronize writing to fast track buffer.
   * This allows LayerOverlay's gizmo to immediately perceive bounding changes via fast track.
   * Also synchronize updating visibleShape to ensure rendering pipeline doesn't crop text to old size.
   *
   * cx/cy compensation: when bounding width/height changes, cx/cy are adjusted
   * so the alignment-aware anchor stays fixed (left edge / centre / right edge
   * horizontally per textData.align; top edge vertically).
   */
  const notifyBoundingChange = useCallback((w: number, h: number) => {
    if (!activeFrame) return;
    const layer = activeFrame.layers.byId[layerId];
    if (!layer) return;

    // Initialize tracking state from current layer on first call
    if (!lastStateRef.current) {
      lastStateRef.current = { w: layer.bounding.w, h: layer.bounding.h, cx: layer.cx, cy: layer.cy };
    }

    // Re-anchor the compensation base when the layer moved/resized EXTERNALLY
    // since the last notify (Cmd/Ctrl+Drag move, gizmo resize during editing):
    // `lastStateRef` only tracks OUR compensations, so without this the next
    // size-changing input (e.g. Enter newline growing the box) computes cx/cy
    // from the stale pre-move base and visibly snaps the box back. See
    // `reanchorCompensationBase` for the staleness guard.
    reanchorCompensationBase(lastStateRef.current, lastLayerObservedRef.current, layer);
    lastLayerObservedRef.current = {
      w: layer.bounding.w,
      h: layer.bounding.h,
      cx: layer.cx,
      cy: layer.cy,
    };

    // Debounce: write only when size actually changes
    if (lastStateRef.current.w === w && lastStateRef.current.h === h) return;

    // Compute cx/cy compensation. Horizontal: align-aware anchor (left edge
    // pinned for left-aligned text, centre for centred, right edge for right) —
    // the box grows in the direction the alignment pulls it, eliminating the
    // visual jump while typing. Vertical: the top edge stays pinned for every
    // alignment.
    const newCx = compensateCenterX(lastStateRef.current.cx, lastStateRef.current.w, w, layer.textData?.align);
    const newCy = compensateCenterY(lastStateRef.current.cy, lastStateRef.current.h, h);

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

