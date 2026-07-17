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

import { EditorContextValue, EditorCommand, LocalShape, LocalSpatial, Frame, Layer } from '@opengpex/editor/core/types';
import { polygonToShape } from '@opengpex/editor/core/helpers/path2d';
import * as P from '@opengpex/editor/core/advanced/protocols';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { isBoundingRing, point2dToLocalShape } from '@opengpex/editor/core/geometry/operators/point2d';

/**
 * Resolve result: contains the layer-local shape and an inversion hint.
 *
 * When `invertedRegular` is true, the original polygon was an "inverted regular"
 * (canvas boundary outer ring + single recognizable rect/ellipse inner ring).
 * In this case, `shape` is the extracted inner regular shape (type:'rect' or 'circle'),
 * and the caller should FLIP its inversion semantics to maintain pixel-perfect boundary
 * alignment with other rect/ellipse masks.
 */
interface ResolvedShape {
  shape: LocalShape;
  invertedRegular: boolean;
}

/**
 * Resolve the selection box into a LocalShape in the target layer's local coordinates.
 *
 * Special handling for "inverted regular" polygons:
 *   When a rect/ellipse is inverted (Cmd+Shift+I), it becomes a polygon with
 *   [canvasBoundaryRing, originalShapeRing]. If we naively convert this to a
 *   `type:'path'` shape, the path renderer applies anti-aliasing at the inner
 *   ring boundary — causing visible seams against the original pixel-perfect
 *   rect/ellipse mask from a prior cut/copy.
 *
 *   Detection: 2-ring polygon where ring[0] ≈ canvas boundary and ring[1] is
 *   recognizable as a rect (4 axis-aligned points) or ellipse (64-point fit).
 *   When detected, we extract the inner ring as a proper LocalShape and signal
 *   `invertedRegular: true` so callers can flip their mask inversion flag —
 *   achieving the same visual result with pixel-perfect boundaries.
 */
function resolveLocalShape(
  box: LocalSpatial,
  activeFrame: Frame,
  targetLayer: Layer,
  geometry: EditorContextValue['geometry']
): ResolvedShape {
  if (!box.regular) {
    const layerPoly = geometry.polygon.frameLocalToLayerLocal(box.spatial, activeFrame, targetLayer);

    // Detect "inverted regular" pattern: [canvasBoundary, regularShape]
    if (layerPoly.rings.length === 2) {
      const outerRing = layerPoly.rings[0];
      const innerRing = layerPoly.rings[1];
      const layerW = targetLayer.bounding.w;
      const layerH = targetLayer.bounding.h;

      if (isBoundingRing(outerRing, layerW, layerH)) {
        const innerShape = point2dToLocalShape([innerRing], box.spatial.antiAliased ?? true);
        if (innerShape) {
          return { shape: innerShape, invertedRegular: true };
        }
      }
    }

    return { shape: polygonToShape(layerPoly), invertedRegular: false };
  }
  return { shape: geometry.shape.frameLocalToLayerLocal(box.spatial, activeFrame, targetLayer), invertedRegular: false };
}

/**
 * CMD+J commands: Create new layers by copying or cutting selections.
 *
 * feather === 0: uses fragmentToLayerLogical (geometric crop, zero overhead).
 * feather > 0: duplicates the full layer + VectorMask (no hard edges).
 */
export const LayerCmdJCommands = {
  copyToLayer: {
    id: P.ADV_LAYER_CMDJ_COPY,
    name: 'Copy to Layer',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: { feather?: number }): Promise<void> => {
      const { activeFrame, activeLayer, state, geometry } = ctx;
      const isClipMode = state.interaction.interactionMode === 'clip';

      if (!activeFrame || !activeLayer || !isClipMode || activeLayer.type !== 'image') {
        ctx.actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      try {
        const latestLayer = ctx.actions.fast.latestLayer(activeFrame.id, activeLayer.id) || activeLayer;
        const box = getClipBox(activeFrame);
        const feather = payload?.feather ?? 0;

        if (box) {
          const { shape: localShape, invertedRegular } = resolveLocalShape(box, activeFrame, latestLayer, geometry);

          if (feather > 0 || invertedRegular) {
            // Feathered OR invertedRegular: duplicate full layer + VectorMask.
            // (see cutToLayer comment for invertedRegular rationale)
            const newName = ctx.layers.getNewLayerName(
              activeFrame.layers.order.map(id => activeFrame.layers.byId[id]), 'Layer'
            );
            // New layers must never inherit lock/interactive state from the source
            const { id: _id, hostId: _pid, role: _role, locked: _locked, interactive: _inter, ...layerData } = latestLayer;
            const newLayer = ctx.layers.getNewLayer({
              ...layerData, name: newName, vectorMasks: [],
            });
            // If invertedRegular, the shape is the inner rect/ellipse — to reveal
            // "everything except that shape" we use inverted=true (pixel-perfect boundary).
            // Normal case: reveal only the shape area → inverted=false.
            newLayer.vectorMasks = [ctx.layers.getNewVectorMask(localShape, invertedRegular, feather)];
            // Record source clip tool so refocus can restore the correct tool slot
            if (activeFrame.latestClipTool) {
              newLayer.metadata = { ...newLayer.metadata, clipTool: activeFrame.latestClipTool };
            }
            ctx.layers.addLayer(activeFrame.id, newLayer);
          } else {
            // Non-feathered, non-invertedRegular: geometric fragment crop.
            const result = ctx.layers.fragmentToLayerLogical(activeFrame, latestLayer, 'Layer');
            if (!result) { ctx.actions.setInteraction({ selectionErrorPulse: Date.now() }); return; }
            result.newLayer.locked = false; // New layers must never inherit lock state
            ctx.layers.addLayer(activeFrame.id, result.newLayer);
          }
        } else {
          // No selection: copy entire layer
          const newName = ctx.layers.getNewLayerName(
            activeFrame.layers.order.map(id => activeFrame.layers.byId[id]), `${latestLayer.name} Copy`
          );
          const newLayer = ctx.layers.getNewLayer({ ...latestLayer, id: undefined, name: newName, hostId: undefined, locked: false, interactive: undefined });
          ctx.layers.addLayer(activeFrame.id, newLayer);
        }
      } catch (err) {
        console.error('[ClipCommands] Layer via Copy failed:', err);
      }
    },
  } as EditorCommand<{ feather?: number } | undefined, Promise<void>>,

  cutToLayer: {
    id: P.ADV_LAYER_CMDJ_CUT,
    name: 'Cut to Layer',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: { feather?: number }): Promise<void> => {
      const { activeFrame, activeLayer, actions, state, geometry } = ctx;
      const isClipMode = state.interaction.interactionMode === 'clip';
      if (!activeFrame || !activeLayer || !isClipMode || activeLayer.type !== 'image') {
        actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      try {
        const latestLayer = actions.fast.latestLayer(activeFrame.id, activeLayer.id) || activeLayer;
        const box = getClipBox(activeFrame);
        if (!box) {
          actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        const feather = payload?.feather ?? 0;
        const { shape: localShape, invertedRegular } = resolveLocalShape(box, activeFrame, latestLayer, geometry);

        // Punch a hole in the original layer (inverted mask).
        // Normal: applyMask(shape, inverted=true) = "hide the selection area".
        // invertedRegular: shape is the inner rect/ellipse. To hide "everything
        // except that shape" (= the inverted selection area), we use inverted=false
        // (= "show only that shape" = hide everything else). This gives pixel-
        // perfect boundary alignment.
        ctx.layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(activeLayer.id)
            .applyMask(localShape, !invertedRegular, feather)
            .patch({ metadata: { ...latestLayer.metadata, clipTool: activeFrame.latestClipTool } });
        });

        if (feather > 0 || invertedRegular) {
          // Feathered OR invertedRegular: duplicate full layer + VectorMask.
          //
          // invertedRegular uses this path even at feather=0 because
          // fragmentToLayerLogical would produce a path-type visibleShape with
          // anti-aliased boundaries, causing seams against the pixel-perfect rect
          // mask on the source layer. Using a proper VectorMask (rect + inverted)
          // ensures both source and fragment share the same pixel-perfect boundary.
          const newName = ctx.layers.getNewLayerName(
            activeFrame.layers.order.map(id => activeFrame.layers.byId[id]), 'Layer'
          );
          // New layers must never inherit lock/interactive state from the source
          const { id: _id, hostId: _pid, role: _role, locked: _locked, interactive: _inter, ...layerData } = latestLayer;
          const newLayer = ctx.layers.getNewLayer({
            ...layerData, name: newName, vectorMasks: [],
          });
          // For the new layer: show the selection area.
          // Normal: inverted=false (show the polygon area).
          // invertedRegular: inverted=true (hide the rect = show everything else).
          newLayer.vectorMasks = [ctx.layers.getNewVectorMask(localShape, invertedRegular, feather)];
          // Record source clip tool so refocus can restore the correct tool slot
          if (activeFrame.latestClipTool) {
            newLayer.metadata = { ...newLayer.metadata, clipTool: activeFrame.latestClipTool };
          }
          ctx.layers.addLayer(activeFrame.id, newLayer);
        } else {
          // Non-feathered, non-invertedRegular: geometric fragment crop.
          const result = ctx.layers.fragmentToLayerLogical(activeFrame, latestLayer, 'Layer');
          if (!result) { actions.setInteraction({ selectionErrorPulse: Date.now() }); return; }
          result.newLayer.locked = false; // New layers must never inherit lock state
          ctx.layers.addLayer(activeFrame.id, result.newLayer);
        }
      } catch (err) {
        console.error('[ClipCommands] Layer via Cut failed:', err);
      }
    },
  } as EditorCommand<{ feather?: number } | undefined, Promise<void>>
};
