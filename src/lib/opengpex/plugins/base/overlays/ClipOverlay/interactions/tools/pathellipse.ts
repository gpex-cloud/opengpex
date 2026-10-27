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
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { ClipOptionsAPI } from '../../../../options/ClipOptions/protocols';
import type { ClipToolAAMap } from '../../../../options/ClipOptions/protocols';
import { createTransformHandler, TransformIntent } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import { makeClipToolGuard } from '../guard';
import { booleanOpFromModifiers, combineWithSelection, createLiveBooleanPreview } from '../boolean';

/**
 * PathEllipseHandler: Path-based ellipse selection interaction handler.
 *
 * Reuses the same drag-to-define-rect interaction as the regular clipbox handler
 * (rect/ellipse tools), but on each update stores a high-density adaptive polygon
 * via `ellipseToPolygon` instead of the fixed 64-point polygon. This ensures
 * the selection stays on the `type:'path'` pipeline (not recognized as circle),
 * providing pixel-perfect fragment/hole complementarity even when the selection
 * extends beyond layer boundaries.
 *
 * Stored in `frame.confinement` as a LocalPolygon.
 */
export const createPathEllipseHandler = (): InteractionHandler => {
  // Boolean combine closure state (mirrors the rect handler): the pre-drag
  // entity and the last rect the drag produced. Captured in getInitialState
  // because the drag's streaming onUpdate overwrites frame.confinement.
  let gestureBase: LocalPolygon | null = null;
  let lastCreateRect: LocalRect | null = null;
  // Throttled live union/difference preview while a boolean create drag runs.
  const liveBooleanPreview = createLiveBooleanPreview();

  return createTransformHandler({
    id: 'clip-pathellipse',
    priority: 100,
    // Shift/Alt spring channels: selection drawing claims them for boolean
    // union/difference (see the rect handler for the full rationale).
    springOverride: ['shift', 'alt'],

    test: (e): TransformIntent | null => {
      // Strategy-driven guard: only fires when `handlerKind: 'pathellipse'`
      if (!makeClipToolGuard('pathellipse')(e)) return null;

      const target = e.nativeEvent.target as HTMLElement;
      if (target.closest('button, a, [data-role="ui"]')) return null;

      // Transform of an EXISTING ellipse selection is owned by the shared
      // SelectionTransformHandler via the TransformGizmo hit zones, and the
      // move handler claims drags inside the polygon — this handler only
      // creates new selections (its old arc edge-resize and box-handle
      // branches are retired along with the custom corner marks).

      // Bare spring fallback: no selection to combine into → yield to the
      // global layer-move spring.
      if ((e.spring.shift || e.spring.alt) && !getClipBox(e.activeFrame)) return null;
      return { category: 'create' };
    },

    getInitialState: (e, intent) => {
      gestureBase = intent.category === 'create' ? getClipBox(e.activeFrame) : null;
      lastCreateRect = null;
      const currentBox = getClipBox(e.activeFrame);
      return currentBox?.rect || asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
    },

    getConstraints: (e) => {
      return {
        aspect: e.activeFrame.imageAspect,
        clamp: true,
        alignToLayerId: e.activeFrame.activeLayerId || undefined
      };
    },

    onUpdate: (e, newRect, tx, context) => {
      const frame = e.activeFrame;
      const currentBox = getClipBox(frame);
      // First update of a fresh drag: inherit the tool's persistent AA preset
      // (configurable with no selection on canvas). Subsequent updates keep
      // the entity flag already stamped on the in-progress polygon.
      const toolAAMap = e.state.getStateSignal<ClipToolAAMap | undefined>(ClipOptionsAPI.signals.clipToolAA);
      const antiAliased = currentBox ? currentBox.antiAliased : (toolAAMap?.pathellipse ?? true);

      // Use 360-point ellipsePathToLocalPolygon to stay on type:'path' pipeline.
      // The 64-point ellipseToLocalPolygon approximation is recognized as type:'circle'
      // by point2dToLocalShape, which breaks path ∩ path intersection in nested cuts.
      const newPoly = e.geometry.polygon.ellipsePathToLocalPolygon(newRect, antiAliased);
      const isCreate = context.intent.category === 'create';
      if (isCreate) {
        lastCreateRect = newRect;
      }

      // Boolean drag: stream the COMBINED shape instead of the raw ellipse so
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
    },

    gestures: [
      {
        name: 'double-click-select-all',
        match: (ctx) => ctx.isDoubleClick && ctx.intent.category === 'create',
        action: (e, tx) => {
          const frame = e.activeFrame;
          const fullCanvasRect = asLocalRect({ x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h });
          const currentBox = getClipBox(frame);
          const toolAAMap = e.state.getStateSignal<ClipToolAAMap | undefined>(ClipOptionsAPI.signals.clipToolAA);
          const antiAliased = currentBox ? currentBox.antiAliased : (toolAAMap?.pathellipse ?? true);
          const newPoly = e.geometry.polygon.ellipsePathToLocalPolygon(fullCanvasRect, antiAliased);
          tx.update({ confinement: newPoly }, 'frame');
        }
      },
      {
        // Boolean combine (P5): Shift unions / Alt subtracts the drawn
        // ellipse into the pre-drag selection. Same-transaction write so
        // undo is a single step back to the pre-drag state.
        name: 'boolean-combine-create',
        match: (ctx) => ctx.hasMoved
          && ctx.intent.category === 'create'
          && (ctx.endModifiers.shift || ctx.endModifiers.alt),
        action: async (e, tx, ctx) => {
          const op = booleanOpFromModifiers(ctx.endModifiers.shift, ctx.endModifiers.alt);
          const base = gestureBase;
          const rawRect = lastCreateRect;
          if (!op || !base || !rawRect) return;
          const incoming = e.geometry.polygon.ellipsePathToLocalPolygon(
            rawRect, base.antiAliased ?? true
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
  });
};
