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

/**
 * PenResizeHandler (priority 165) — drag a gizmo corner/edge handle to
 * resize the active pen layer. Built on the shared `createTransformHandler`
 * (same infra as marker / text resize).
 *
 * The layer model has NO scale channel (`Layer.scale` is deprecated at 1.0),
 * so the resize BAKES into penData: every anchor and relative handle offset
 * is scaled by the bounding factors (pure `scalePenData`), the bounding and
 * `visibleShape` are written to the new extents, and the world centre is
 * re-derived through the shared orientation helper — the same math the
 * marker resize uses. The pen origin convention (layer-local, origin =
 * bounding top-left, set at commit) is what makes the bake a straight
 * multiply. The stroke width (`penStyle.stroke.width`) intentionally does
 * NOT scale: a fixed-size stroke tracks the path outline, per the tool's
 * ruling.
 *
 * The visibleShape write matters as much as the bounding: the factory seeds
 * visibleShape = full bounding at creation and the scene assembler turns any
 * visibleShape into the LayerNode's crop — a stale rect here clips the GPU
 * face render to the OLD extents while the SVG overlay (drawn from penData)
 * keeps up.
 *
 * Non-silent → a single undoable checkpoint per resize gesture.
 */

import type { InteractionEvent, InteractionHandler, Layer, LocalRect, PenPathData } from '@opengpex/editor/core/types';
import { asLocalShape } from '@opengpex/editor/core/types';
import { createTransformHandler, ResizeHandle } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import { ACTIVE_CRAFT_KEY } from './shared';

/** Minimum bounding side (layer-local px) so a resize can never collapse. */
const MIN_SIZE = 1;

/** Binds to the active pen layer (gizmo handles are pen-craft chrome). */
function activePenLayer(e: InteractionEvent): Layer | null {
  if (e.state.interaction.interactionMode !== 'craft') return null;
  if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'pen') return null;
  const frame = e.activeFrame;
  const activeId = frame.activeLayerId;
  const layer = activeId ? frame.layers.byId[activeId] : null;
  if (!layer || layer.type !== 'vector' || !layer.penData) return null;
  return layer;
}

export const createPenResizeHandler = (): InteractionHandler => {
  // Snapshot of the pen layer being resized, captured at gesture start.
  let resizeLayerId: string | null = null;
  let startPenData: PenPathData | null = null;
  let startBounding = { w: 0, h: 0 };
  // Orientation-aware resize snapshot (non-null only for rotated/mirrored
  // layers): the world centre and the local-axes rect at gesture start, used
  // to map the local resize result back to world cx/cy.
  let startCenter: { cx: number; cy: number } | null = null;
  let startLocalRect: { x: number; y: number; w: number; h: number } | null = null;

  return createTransformHandler({
    id: 'pen-resize',
    priority: 165,

    test: (e) => {
      const target = e.nativeEvent.target as HTMLElement;
      const handleEl = target.closest('[data-gizmo-handle]') as HTMLElement | null;
      if (!handleEl) return null;

      const handle = handleEl.dataset.gizmoHandle;
      if (!handle) return null;

      const layer = activePenLayer(e);
      if (!layer) return null;

      resizeLayerId = layer.id;
      startPenData = layer.penData!;
      startBounding = { w: layer.bounding.w, h: layer.bounding.h };

      return { category: 'resize', handle: handle as ResizeHandle };
    },

    getInitialState: (e) => {
      const frame = e.activeFrame;
      const layer = resizeLayerId ? frame.layers.byId[resizeLayerId] : null;
      const canvas = frame.canvas;
      if (!layer) return { x: 0, y: 0, w: 0, h: 0 } as LocalRect;

      // Rotated / mirrored layer → work in the layer's LOCAL axes. Origin is
      // the bounding top-left (the penData origin), so the rect is simply
      // (0,0,w,h); the framework maps pointer deltas into this space via
      // getOrientation.
      if (e.geometry.transform.isRotatedPose(layer)) {
        startCenter = { cx: layer.cx, cy: layer.cy };
        startLocalRect = { x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h };
        return startLocalRect as LocalRect;
      }

      // Axis-aligned layer → canvas-local rect (original marker behaviour,
      // keeps canvas clamping / edge snapping semantics unchanged).
      startCenter = null;
      startLocalRect = null;
      return {
        x: canvas.w / 2 + layer.cx - layer.bounding.w / 2,
        y: canvas.h / 2 + layer.cy - layer.bounding.h / 2,
        w: layer.bounding.w,
        h: layer.bounding.h,
      } as LocalRect;
    },

    // Opt into orientation-aware resize: a rotated pen layer carries non-zero
    // `rotation` with an unchanged `bounding`, so the resize math must run in
    // the layer's own axes. cx/cy are supplied so the framework can project
    // the local rect back into canvas space for rotation-aware edge snapping.
    getOrientation: (e) => {
      const layer = resizeLayerId ? e.activeFrame.layers.byId[resizeLayerId] : null;
      if (!layer) return null;
      return { rotation: layer.rotation, flip: layer.flip, cx: layer.cx, cy: layer.cy };
    },

    // Free-form resize (aspect lock only via Shift, handled by the framework);
    // unclamped so paths may extend past the canvas edge like marker boxes.
    getConstraints: () => ({ aspect: undefined, clamp: false }),

    onUpdate: (e, newRect, tx, context) => {
      if (!resizeLayerId || !startPenData) return;
      const frame = e.activeFrame;
      const canvas = frame.canvas;

      const finalW = Math.max(MIN_SIZE, newRect.w);
      const finalH = Math.max(MIN_SIZE, newRect.h);

      // Recover the new world centre.
      let newCx: number;
      let newCy: number;

      if (context.orientation && startCenter && startLocalRect) {
        // Orientation-aware path: newRect is in the layer's LOCAL axes. The
        // shared core helper uses the renderer's own O = R × F convention.
        const worldCenter = e.geometry.space.localToWorldCenter(
          startCenter,
          startLocalRect,
          { x: newRect.x, y: newRect.y, w: finalW, h: finalH },
          context.orientation
        );
        newCx = worldCenter.x;
        newCy = worldCenter.y;
      } else {
        // Axis-aligned path: canvas-local rect → world cx/cy (unchanged).
        newCx = newRect.x + finalW / 2 - canvas.w / 2;
        newCy = newRect.y + finalH / 2 - canvas.h / 2;
      }

      // Bake the scale into the payload (anchors + relative handle offsets);
      // the stroke width deliberately stays fixed.
      let nextPenData: PenPathData = startPenData;
      if (startBounding.w > 0 && startBounding.h > 0) {
        const sx = finalW / startBounding.w;
        const sy = finalH / startBounding.h;
        nextPenData = e.geometry.bezier.mapPathAnchors(startPenData, (p) => ({ x: p.x * sx, y: p.y * sy }));
      }

      tx.update({
        cx: newCx,
        cy: newCy,
        bounding: { w: finalW, h: finalH },
        // Track the factory-seeded visibleShape to the new extents: the
        // scene assembler crops the GPU render by this rect (see module doc).
        visibleShape: asLocalShape({ x: 0, y: 0, w: finalW, h: finalH }),
        penData: nextPenData,
      }, 'layer', resizeLayerId);
    },

    onEnd: () => {
      resizeLayerId = null;
      startPenData = null;
      startCenter = null;
      startLocalRect = null;
    },

    onCancel: () => {
      resizeLayerId = null;
      startPenData = null;
      startCenter = null;
      startLocalRect = null;
    },
  });
};
