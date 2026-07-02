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

/**
 * Resolve the selection box into a LocalShape in the target layer's local coordinates.
 */
function resolveLocalShape(
  box: LocalSpatial,
  activeFrame: Frame,
  targetLayer: Layer,
  geometry: EditorContextValue['geometry']
): LocalShape {
  if (!box.regular) {
    const layerPoly = geometry.polygon.frameLocalToLayerLocal(box.spatial, activeFrame, targetLayer);
    return polygonToShape(layerPoly);
  }
  return geometry.shape.frameLocalToLayerLocal(box.spatial, activeFrame, targetLayer);
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
          if (feather > 0) {
            // Feathered: duplicate full layer + reveal VectorMask.
            const localShape = resolveLocalShape(box, activeFrame, latestLayer, geometry);
            const newName = ctx.layers.getNewLayerName(
              activeFrame.layers.order.map(id => activeFrame.layers.byId[id]), 'Layer'
            );
            const { id: _id, parentId: _pid, role: _role, ...layerData } = latestLayer;
            const newLayer = ctx.layers.getNewLayer({
              ...layerData, name: newName, vectorMasks: [],
            });
            newLayer.vectorMasks = [ctx.layers.getNewVectorMask(localShape, false, feather)];
            ctx.layers.addLayer(activeFrame.id, newLayer);
          } else {
            // Non-feathered: geometric fragment crop.
            const result = ctx.layers.fragmentToLayerLogical(activeFrame, latestLayer, 'Layer');
            if (!result) { ctx.actions.setInteraction({ selectionErrorPulse: Date.now() }); return; }
            ctx.layers.addLayer(activeFrame.id, result.newLayer);
          }
        } else {
          // No selection: copy entire layer
          const newName = ctx.layers.getNewLayerName(
            activeFrame.layers.order.map(id => activeFrame.layers.byId[id]), `${latestLayer.name} Copy`
          );
          const newLayer = ctx.layers.getNewLayer({ ...latestLayer, id: undefined, name: newName, parentId: undefined });
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
        const localShape = resolveLocalShape(box, activeFrame, latestLayer, geometry);

        // Punch a hole in the original layer (inverted mask)
        ctx.layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(activeLayer.id).applyMask(localShape, true, feather);
        });

        if (feather > 0) {
          // Feathered: duplicate full layer + reveal VectorMask.
          const newName = ctx.layers.getNewLayerName(
            activeFrame.layers.order.map(id => activeFrame.layers.byId[id]), 'Layer'
          );
          const { id: _id, parentId: _pid, role: _role, ...layerData } = latestLayer;
          const newLayer = ctx.layers.getNewLayer({
            ...layerData, name: newName, vectorMasks: [],
          });
          newLayer.vectorMasks = [ctx.layers.getNewVectorMask(localShape, false, feather)];
          ctx.layers.addLayer(activeFrame.id, newLayer);
        } else {
          // Non-feathered: geometric fragment crop.
          const result = ctx.layers.fragmentToLayerLogical(activeFrame, latestLayer, 'Layer');
          if (!result) { actions.setInteraction({ selectionErrorPulse: Date.now() }); return; }
          ctx.layers.addLayer(activeFrame.id, result.newLayer);
        }
      } catch (err) {
        console.error('[ClipCommands] Layer via Cut failed:', err);
      }
    },
  } as EditorCommand<{ feather?: number } | undefined, Promise<void>>
};
