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

import { EditorContextValue, EditorCommand, ClipboardLayerMetadata, LocalShape, isPolygon } from '@opengpex/editor/core/types';
import { polygonToShape } from '@opengpex/editor/core/helpers/path2d';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import * as P from '@opengpex/editor/core/advanced/protocols';


// Removed direct dependency on storage singleton, using ctx injection instead

/**
 * Extract common logic of Cut and Copy: generate physical fragment and write to clipboard.
 * Caller must pass an already-resolved non-null `selection`.
 */
async function copyCropBoxToClipboard(
  ctx: EditorContextValue,
  nameType: 'Layer'
) {
  const { activeFrame, activeLayer, actions } = ctx;
  if (!activeFrame || !activeLayer) return null;

  const latestLayer = actions.fast.latestLayer(activeFrame.id, activeLayer.id) || activeLayer;

  // 1. Generate Physical Track: bake PNG Blob, primarily for external applications (e.g., WeChat, Word) to paste
  const physicalResult = await ctx.layers.fragmentToLayerPhysical(activeFrame, latestLayer, nameType);
  if (!physicalResult) {
    actions.setInteraction({ selectionErrorPulse: Date.now() });
    return null;
  }

  // 2. Generate Logical Track: generate a lossless layer object referencing the original image plus a visibleShape mask, specifically for internal system pasting
  const logicalResult = ctx.layers.fragmentToLayerLogical(activeFrame, latestLayer, nameType);

  // 3. Composite clipboard write: external software reads physicalResult.url (Blob), internal Paste command reads Metadata.layer (Logical Layer)
  await ctx.clipboard.writeByUrl(physicalResult.url, {
    layer: logicalResult ? logicalResult.newLayer : physicalResult.newLayer
  });

  return {
    ...physicalResult,
    newLayer: logicalResult ? logicalResult.newLayer : physicalResult.newLayer
  };
}


/**
 * CLIP_COMMANDS: Core clip and selection commands (Cut, Copy, Paste)
 */
export const LayerClipCommands = {
  copy: {
    id: P.ADV_LAYER_CLIP_COPY,
    name: 'Copy',
    execute: (ctx: EditorContextValue): Promise<void> => {
      const { assets } = ctx;
      return assets.withSession(async () => {
        const { activeFrame, activeLayer, actions, state } = ctx;
        const isClipMode = state.interaction.interactionMode === 'clip';

        if (!activeFrame || !activeLayer || !isClipMode || activeLayer.type !== 'image') {
          actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        try {
          const box = getClipBox(activeFrame);

          if (box) {
            await copyCropBoxToClipboard(ctx, 'Layer');
          } else {
            // Without selection: copy the entire layer
            await ctx.clipboard.writeByUrl(activeLayer.src, {
              layer: activeLayer
            });
          }
        } catch (err) {
          console.error('[ClipCommands] Copy operation failed:', err);
        }
      });
    },
    shortcut: { key: 'c', meta: true }
  } as EditorCommand<void, Promise<void>>,

  cut: {
    id: P.ADV_LAYER_CLIP_CUT,
    name: 'Cut',
    undoable: true,
    execute: (ctx: EditorContextValue): Promise<void> => {
      const { assets } = ctx;
      return assets.withSession(async () => {
        const { activeFrame, activeLayer, actions, state } = ctx;
        const isClipMode = state.interaction.interactionMode === 'clip';

        if (!activeFrame || !activeLayer || !isClipMode || activeLayer.type !== 'image') {
          actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        try {
          const box = getClipBox(activeFrame);

          if (box) {
            const result = await copyCropBoxToClipboard(ctx, 'Layer');
            if (!result) return;

            ctx.layers.updateLayer(activeFrame.id, tx => {
              tx.edit(activeLayer.id)
                .applyMask(result.localShape, true);
            });

          } else {
            // Without selection: cut the entire layer (clear content, keep layer)
            await ctx.clipboard.writeByUrl(activeLayer.src, {
              layer: activeLayer
            });

            ctx.layers.updateLayer(activeFrame.id, tx => {
              tx.edit(activeLayer.id).maskLayer();
            });
          }
        } catch (err) {
          console.error('[ClipCommands] Cut operation failed:', err);
        }
      });
    },
    shortcut: { key: 'x', meta: true }
  } as EditorCommand<void, Promise<void>>,

  paste: {
    id: P.ADV_LAYER_CLIP_PASTE,
    name: 'Paste',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: ClipboardLayerMetadata | { e?: ClipboardEvent }): Promise<void> => {
      const { activeFrame, activeLayer, geometry, clipboard, state } = ctx;
      if (!activeFrame) return;

      try {
        let meta: ClipboardLayerMetadata | undefined = (payload && 'assetId' in payload) ? payload : undefined;
        const event = (payload && 'e' in payload) ? payload.e : undefined;
        let blob: Blob | undefined = undefined;

        if (!meta) {
          const res = await clipboard.read(event);
          meta = res?.metadata;
          blob = res?.blob;
        }

        let newLayer;

        if (meta?.layer) {
          // ==========================================
          // Block 1: Internal Paste (contains full layer object)
          // Remap the paste position to the center of the current viewport, avoiding coordinate misalignment across boards or after viewport changes
          // ==========================================
          const { id: _oldId, ...layerWithoutId } = meta.layer;
          const smartName = ctx.layers.getNewLayerName(activeFrame.layers.order.map(id => activeFrame.layers.byId[id]), 'Layer');

          // Calculate the world coordinates corresponding to the center of the current viewport (layer.cx/cy use the world coordinate system, origin at the canvas center)
          const vDim = state.ui.viewportDim;
          const worldCenter = geometry.space.screenToWorld(vDim.w / 2, vDim.h / 2, activeFrame);

          // Logical paste should remain in-place (in-place paste) because cx/cy and visibleShape of logical fragments are designed for precise re-pasting
          // Only remap to the viewport center if the source artboard and target artboard are different
          console.debug(
            '[ClipCommands:paste] Internal paste positioning debug:',
            `\n  meta.layer cx/cy: (${meta.layer.cx}, ${meta.layer.cy})`,
            `\n  meta.layer bounding: ${meta.layer.bounding?.w}×${meta.layer.bounding?.h}`,
            `\n  meta.layer visibleShape: ${JSON.stringify(meta.layer.visibleShape?.rect)}`,
            `\n  viewport dim: ${vDim.w}×${vDim.h}`,
            `\n  worldCenter: (${worldCenter.x.toFixed(1)}, ${worldCenter.y.toFixed(1)})`,
            `\n  activeFrame.canvas: ${activeFrame.canvas.w}×${activeFrame.canvas.h}`,
            `\n  activeFrame.camera: (${activeFrame.camera.x.toFixed(1)}, ${activeFrame.camera.y.toFixed(1)}, k=${activeFrame.camera.k.toFixed(3)})`,
            `\n  → using original cx/cy (in-place paste)`
          );

          newLayer = ctx.layers.getNewLayer({
            ...layerWithoutId,
            name: smartName
          });
        } else if (blob) {
          // ==========================================
          // Block 2: External Image Paste (Blob)
          // ==========================================
          newLayer = await ctx.layers.createLayerFromBlob(blob, activeFrame);
        } else {
          // Neither internal paste nor image, ignore directly
          return;
        }

        // Calculate insertion index
        let insertIndex: number | undefined = undefined;
        if (activeLayer) {
          const hostId = activeLayer.parentId || activeLayer.id;
          const familyIndices = activeFrame.layers.order
            .map((id, i) => {
              const l = activeFrame.layers.byId[id];
              return (l.parentId === hostId || l.id === hostId ? i : -1);
            })
            .filter(i => i !== -1);
          insertIndex = Math.max(...familyIndices) + 1;
        }

        ctx.layers.addLayer(activeFrame.id, newLayer, insertIndex);
      } catch (err) {
        console.error('[ClipCommands] Paste operation failed:', err);
      }
    }
  } as EditorCommand<ClipboardLayerMetadata, Promise<void>>,

  toMask: {
    id: P.ADV_LAYER_CLIP_TO_MASK,
    name: 'Apply Selection as Layer Mask',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: { layerId?: string }): Promise<void> => {
      const { activeFrame, activeLayer, actions, geometry, layers } = ctx;
      if (!activeFrame) return;

      const box = getClipBox(activeFrame);
      if (!box) {
        actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      // Resolve target layer: explicit payload > activeLayer
      const targetLayerId = payload?.layerId ?? activeLayer?.id;
      if (!targetLayerId) {
        actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }
      const targetLayer = activeFrame.layers.byId[targetLayerId];
      if (!targetLayer) {
        actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      // Derive LocalShape for the mask:
      let localShape: LocalShape;
      if (!box.regular) {
        // Irregular path (lasso/wand): project frame-local → layer-local, then to shape
        const layerPoly = geometry.polygon.frameLocalToLayerLocal(box.spatial, activeFrame, targetLayer);
        localShape = polygonToShape(layerPoly);
      } else {
        // Regular shape (rect/ellipse): already a LocalShape, use directly
        localShape = box.spatial;
      }

      // Apply as VectorMask (Reveal Selection — inverted=false)
      layers.updateLayer(activeFrame.id, tx => {
        tx.edit(targetLayer.id).applyMask(localShape, false);
      });

      // Clear the applied selection slot (shares the same undo atom):
      if (!box.regular) {
        const clipToolId = activeFrame.latestClipTool || 'rect';
        actions.setClipBox(activeFrame.id, clipToolId, null);
      }
    },
  } as EditorCommand<{ layerId?: string } | undefined, Promise<void>>,

  drill: {
    id: P.ADV_LAYER_CLIP_DRILL,
    name: 'Delete Selection',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<void> => {
      const { activeFrame, activeLayer, actions, geometry } = ctx;
      const isClipActive = ctx.state.interaction.interactionMode === 'clip';
      if (!activeFrame || !activeLayer || !isClipActive) return;

      try {
        const latestLayer = actions.fast.latestLayer(activeFrame.id, activeLayer.id) || activeLayer;

        const box = getClipBox(activeFrame);
        if (!box) return;

        const localShape = !box.regular
          ? polygonToShape(geometry.polygon.frameLocalToLayerLocal(box.spatial, activeFrame, latestLayer))
          : geometry.shape.frameLocalToLayerLocal(box.spatial, activeFrame, latestLayer);

        ctx.layers.updateLayer(activeFrame.id, tx => {
          tx.edit(activeLayer.id)
            .applyMask(localShape, true);
        });
      } catch (err) {
        console.error('[ClipCommands] Drill selection failed:', err);
      }
    },
    shortcuts: [
      { key: 'Backspace' },
      { key: 'Delete' }
    ]
  } as EditorCommand<void, Promise<void>>
};
