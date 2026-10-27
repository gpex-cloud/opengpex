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

import {
  InteractionHandler,
  LocalPolygon,
  LocalRect,
  asLocalRect,
} from '@opengpex/editor/core/types';
import { getClipBox, getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import {
  ClipOptionsAPI,
} from '../../../../options/ClipOptions/protocols';
import { createTransformHandler, TransformIntent } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import { makeClipToolGuard } from '../guard';
import { booleanOpFromModifiers, combineWithSelection, createLiveBooleanPreview } from '../boolean';

/**
 * ClipBoxHandler: Core interaction handler for clip tool.
 * Handles clip box: Resize and Create.
 *
 * Move and Peel are handled by the unified `createSelectionMoveHandler` which
 * operates on any selection type (rect/polygon). This handler only
 * retains resize handles and new-selection creation.
 *
 * Re-Canvas interactions are handled by the dedicated `createReCanvasHandler`
 * (in re-canvas.ts) which has priority 115 and intercepts first when Re-Canvas
 * is active. This handler explicitly skips Re-Canvas for safety.
 */
export const createClipBoxHandler = (): InteractionHandler => {
  // Selection entity present when a create gesture started, and the raw rect
  // the drag last produced. Boolean combine (Shift/Alt) folds the freshly
  // drawn rect into the base instead of replacing it. The base is captured in
  // getInitialState because the drag's own streaming onUpdate overwrites
  // frame.confinement with the in-progress rect — by gesture end the
  // pre-drag entity is only reachable through this closure.
  let gestureBase: LocalPolygon | null = null;
  let lastCreateRect: LocalRect | null = null;
  // Throttled live union/difference preview while a boolean create drag runs.
  const liveBooleanPreview = createLiveBooleanPreview();

  return createTransformHandler({
    id: 'clip-box',
    priority: 100,
    // Selection drawing attaches spring semantics to Shift (boolean union)
    // and Alt (boolean difference): without this declaration the dispatcher
    // filters the handler out while either key is held and the global
    // layer-move fallback owns the press — Shift+drag would move a layer
    // instead of drawing a selection.
    springOverride: ['shift', 'alt'],

    test: (e): TransformIntent | null => {
      // Strategy-driven guard: only fires when the active tool declares
      // `handlerKind: 'clipbox'` (the rect row).
      if (!makeClipToolGuard('clipbox')(e)) return null;

      // Explicitly skip Re-Canvas (handled by dedicated re-canvas handler)
      if (e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas)) return null;

      const target = e.nativeEvent.target as HTMLElement;

      // Resize of an EXISTING selection is owned by the shared
      // SelectionTransformHandler via the TransformGizmo hit zones, and the
      // move handler owns drags on the move surface — this handler only
      // creates new selections (its old corner/edge-resize branches are
      // retired along with the custom corner marks).

      if (target.closest('button, a, [data-role="ui"]')) return null;

      // Accept clicks both inside AND outside canvas for creating selections.
      // Outside-canvas clicks allow the user to start a selection from the
      // canvas edge (Photoshop Marquee behavior). The TransformHandler will
      // clamp the starting anchor to the nearest canvas edge.
      // Bare spring fallback: Shift/Alt is held but there is no selection to
      // combine into — yield the press to the global layer-move spring.
      if ((e.spring.shift || e.spring.alt) && !getClipBox(e.activeFrame)) return null;
      return { category: 'create' };
    },

    getInitialState: (e, intent) => {
      // Boolean combine: capture the pre-drag entity only for create intents
      // (resize/move never replace the selection, so they need no base).
      gestureBase = intent.category === 'create' ? getClipBox(e.activeFrame) : null;
      lastCreateRect = null;
      const currentShape = getRegularClipShape(e.activeFrame);
      return currentShape?.rect || asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
    },

    getConstraints: (e) => {
      return {
        aspect: e.activeFrame.imageAspect,
        clamp: true,
        alignToLayerId: e.activeFrame.activeLayerId || undefined
      };
    },

    onUpdate: (e, newRect, tx, _context) => {
      const frame = e.activeFrame;
      const currentShape = getRegularClipShape(frame);

      // Determine the active tool slot from the per-frame field, NOT from
      // the existing shape's type.
      // This handler only serves the rect clipbox (pathellipse owns its own
      // handler), so the slot id is always 'rect'.
      const activeTool = 'rect' as const;
      // Write a proper LocalPolygon (with rings) so downstream consumers
      // (polygonToShape, localToWorldPolygon, etc.) never see rings=undefined.
      const antiAliased = currentShape?.antiAliased;
      const newPoly = e.geometry.polygon.regularShapeToLocalPolygon(activeTool, newRect, antiAliased);
      const isCreate = _context.intent.category === 'create';
      if (isCreate) {
        lastCreateRect = newRect;
      }

      // Boolean drag: stream the COMBINED shape instead of the raw rect so
      // the base selection never disappears mid-drag (WYSIWYG). The gesture's
      // final exact combine still runs in the 'boolean-combine-create' action.
      const previewOp = isCreate && gestureBase
        ? booleanOpFromModifiers(e.spring.shift, e.spring.alt)
        : null;
      if (previewOp && gestureBase) {
        liveBooleanPreview({
          base: gestureBase,
          incoming: newPoly,
          op: previewOp,
          geometry: e.geometry,
          tx,
        });
      } else {
        tx.update({ confinement: newPoly }, 'frame');
      }

      // Sync exchange layer if needed
      if (frame.activeLayerId) {
        const activeLayer = frame.activeLayerId ? frame.layers.byId[frame.activeLayerId] : undefined;
        const exchangeLayer = (activeLayer?.role === 'exchange')
          ? activeLayer
          : frame.layers.order.map(id => frame.layers.byId[id]).find(l => l.role === 'exchange' && l.hostId === frame.activeLayerId);

        if (exchangeLayer) {
          // Convert clip box center from frame-local to world coordinates
          const worldCenter = e.geometry.space.localToWorld(newRect.x + newRect.w / 2, newRect.y + newRect.h / 2, frame);
          // Account for layer orientation (rotation/flip) when computing anchor.
          const vr = exchangeLayer.visibleShape?.rect;
          const vox = vr?.x ?? 0;
          const voy = vr?.y ?? 0;
          const pose = e.geometry.transform.computeFragmentCenter(worldCenter, { x: vox, y: voy }, exchangeLayer.rotation, exchangeLayer.flip);
          tx.update({ cx: pose.x, cy: pose.y }, 'layer', exchangeLayer.id);
        }
      }
    },

    // ── Declarative Gesture Rules ──
    // Only creation-type interactions support double-click (select all) and
    // static-click (clear selection). Resize handle interactions should NEVER
    // trigger these gestures — the intent.category check ensures this.
    gestures: [
      {
        name: 'double-click-select-all',
        match: (ctx) => ctx.isDoubleClick && ctx.intent.category === 'create',
        action: (e, tx) => {
          const frame = e.activeFrame;
          const fullCanvasRect = asLocalRect({ x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h });

          const activeTool = 'rect' as const;
          const currentShape = getRegularClipShape(frame);
          const antiAliased = currentShape?.antiAliased;
          const newPoly = e.geometry.polygon.regularShapeToLocalPolygon(activeTool, fullCanvasRect, antiAliased);
          tx.update({ confinement: newPoly }, 'frame');
        }
      },
      {
        // Boolean combine (P5): Shift unions / Alt subtracts the drawn rect
        // into the pre-drag selection. Runs inside the same transaction —
        // the streamed raw-rect updates and this final boolean write commit
        // together, so undo is a single step back to the pre-drag state.
        name: 'boolean-combine-create',
        match: (ctx) => ctx.hasMoved
          && ctx.intent.category === 'create'
          && (ctx.endModifiers.shift || ctx.endModifiers.alt),
        action: async (e, tx, ctx) => {
          const op = booleanOpFromModifiers(ctx.endModifiers.shift, ctx.endModifiers.alt);
          const base = gestureBase;
          const rawRect = lastCreateRect;
          if (!op || !base || !rawRect) return;
          const incoming = e.geometry.polygon.regularShapeToLocalPolygon(
            'rect', rawRect, base.antiAliased ?? true
          );
          const combined = await combineWithSelection(base, incoming, op, e.geometry);
          tx.update({ confinement: combined }, 'frame');
        }
      },
      {
        name: 'static-click-clear',
        match: (ctx) => !ctx.hasMoved && ctx.intent.category === 'create',
        action: (e) => {
          e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
        }
      }
    ],

    // No onEnd needed — autoCommit handles resize/move completion.
  });
};
