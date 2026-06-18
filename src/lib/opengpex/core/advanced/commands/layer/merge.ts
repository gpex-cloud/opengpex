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

import { EditorContextValue, EditorCommand, Layer } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * Determines whether a layer needs to be pre-rasterized:
 * - The visual content of a text layer is drawn by the real-time text renderer, and the bitmap may be a transparent pixel placeholder.
 * - The visual content of a color layer is a solid color fill, with no actual bitmap asset.
 * - Any layer using asset-transparent-pixel as a placeholder.
 */
function needsPreRasterize(layer: Layer): boolean {
  return layer.type === 'text' || layer.type === 'color' || layer.assetId === 'asset-transparent-pixel';
}

/**
 * Rasterizes layers that need pre-rasterization and returns the updated layer array.
 * Ensures each layer has a valid bitmap asset before being sent to the Worker.
 */
async function preRasterizeLayers(layers: Layer[], pixels: EditorContextValue['pixels']): Promise<Layer[]> {
  return Promise.all(layers.map(async (layer) => {
    if (needsPreRasterize(layer)) {
      const asset = await pixels.rasterize.layer(layer);
      return { ...layer, src: asset.url, assetId: asset.id };
    }
    return layer;
  }));
}

/**
 * LayerMergeCommands: Advanced layer merge commands.
 * Handles merging layers down and merging visible layers.
 */
export const LayerMergeCommands = {
  mergeDown: {
    id: P.ADV_LAYER_MERGE_DOWN,
    name: 'Merge Layer Down',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<void> => {
      const { activeFrame, activeLayer, pixels, layers, actions, geometry } = ctx;
      if (!activeFrame || !activeLayer) return;

      const hostLayers = layers.getHostLayers(activeFrame.layers.order.map(id => activeFrame.layers.byId[id]));
      const activeIndex = hostLayers.findIndex(l => l.id === activeLayer.id);

      if (activeIndex === 0) {
        actions.setInteraction({ hud: { message: 'Cannot merge down. This is the bottom-most layer.', type: 'error' } });
        return;
      }

      const targetLayer = hostLayers[activeIndex - 1];


      try {
        const worldShape = geometry.shape.unitedShapeOfLayers([targetLayer, activeLayer]);
        if (!worldShape) throw new Error('Could not calculate bounding union');

        const unionW = worldShape.rect.w;
        const unionH = worldShape.rect.h;
        const { x: unionCx, y: unionCy } = geometry.space.getRectCenter(worldShape.rect);

        // Pre-rasterize text/color layers to ensure the Worker has valid bitmaps to composite
        const rasterizedLayers = await preRasterizeLayers([targetLayer, activeLayer], pixels);

        const targetDpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
        const assetResult = await pixels.worker.asAsset(
          pixels.worker.mergeLayersWithShape(
            rasterizedLayers,
            worldShape,
            { targetDpr }
          )
        );

        if (!assetResult) throw new Error('Composite merge failed');

        layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(targetLayer.id)
            .setAsset(assetResult)
            .resetWithBounds(unionW, unionH, unionCx, unionCy);
        });

        // Type inference after merging:
        // - paint + paint -> paint | text + text -> text | color + color -> paint
        // - craft mixing (any combination of paint/text/color) -> paint (the merged result is essentially bitmap drawing content)
        // - involving image -> image (degrades to a general bitmap)
        const isCraftLayer = (t: string) => t === 'paint' || t === 'text' || t === 'color';
        const bothCraft = isCraftLayer(activeLayer.type) && isCraftLayer(targetLayer.type);
        const mergedType = bothCraft
          ? (activeLayer.type === targetLayer.type && activeLayer.type !== 'color'
            ? activeLayer.type
            : 'paint')
          : 'image';

        actions.updateLayer(activeFrame.id, targetLayer.id, {
          type: mergedType,
          textData: undefined,
          bitmapMasks: [],
        });

        layers.removeLayers(activeFrame.id, activeLayer.id);
        layers.activate(activeFrame.id, targetLayer.id);

      } catch (err) {
        console.error('[LayerPanel] Merge down failed:', err);
        actions.setInteraction({ hud: { message: 'Merge down failed.', type: 'error' } });
      }
    }
  } as EditorCommand<void, Promise<void>>,

  mergeVisible: {
    id: P.ADV_LAYER_MERGE_VISIBLE,
    name: 'Merge Visible Layers',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<void> => {
      const { activeFrame, pixels, layers, actions, geometry } = ctx;
      if (!activeFrame) return;

      const hostLayers = layers.getHostLayers(activeFrame.layers.order.map(id => activeFrame.layers.byId[id]));
      const visibleLayers = hostLayers.filter(l => l.visible);

      if (visibleLayers.length < 2) {
        actions.setInteraction({ hud: { message: 'Need at least 2 visible layers to merge.', type: 'error' } });
        return;
      }

      const targetLayer = visibleLayers[0];
      const items = visibleLayers.slice(1);

      try {
        const worldShape = geometry.shape.unitedShapeOfLayers(visibleLayers);
        if (!worldShape) throw new Error('Could not calculate bounding union');

        const unionW = worldShape.rect.w;
        const unionH = worldShape.rect.h;
        const { x: unionCx, y: unionCy } = geometry.space.getRectCenter(worldShape.rect);

        // Pre-rasterize text/color layers to ensure the Worker has valid bitmaps to composite
        const rasterizedLayers = await preRasterizeLayers(visibleLayers, pixels);

        const targetDpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
        const assetResult = await pixels.worker.asAsset(
          pixels.worker.mergeLayersWithShape(
            rasterizedLayers,
            worldShape,
            { targetDpr }
          )
        );

        if (!assetResult) throw new Error('Composite merge failed');

        layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(targetLayer.id)
            .setAsset(assetResult)
            .resetWithBounds(unionW, unionH, unionCx, unionCy);
        });

        // Type inference after merging (consistent with mergeDown):
        // - all paint -> paint | all text -> text
        // - craft mixing (any combination of paint/text/color) -> paint
        // - involving image -> image (degrades to a general bitmap)
        const isCraftLayer = (t: string) => t === 'paint' || t === 'text' || t === 'color';
        const allCraft = visibleLayers.every(l => isCraftLayer(l.type));
        const allTypes = visibleLayers.map(l => l.type);
        const uniqueTypes = [...new Set(allTypes)];
        const mergedType: Layer['type'] = allCraft
          ? (uniqueTypes.length === 1 && uniqueTypes[0] !== 'color' ? uniqueTypes[0] as Layer['type'] : 'paint')
          : 'image';

        actions.updateLayer(activeFrame.id, targetLayer.id, {
          type: mergedType,
          textData: undefined,
          bitmapMasks: [],
        });

        items.forEach(item => {
          layers.removeLayers(activeFrame.id, item.id);
        });

        layers.activate(activeFrame.id, targetLayer.id);

      } catch (err) {
        console.error('[LayerPanel] Merge visible failed:', err);
        actions.setInteraction({ hud: { message: 'Merge visible failed.', type: 'error' } });
      }
    }
  } as EditorCommand<void, Promise<void>>,

  rasterize: {
    id: P.ADV_LAYER_MERGE_RASTERIZE,
    name: 'Rasterize Layer',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: { layerId?: string }): Promise<void> => {
      const { activeFrame, pixels, layers, actions, geometry } = ctx;
      if (!activeFrame) return;

      const layerId = payload?.layerId || ctx.activeLayer?.id;
      if (!layerId) return;

      const layer = activeFrame.layers.byId[layerId];
      if (!layer) return;

      try {
        const worldShape = geometry.shape.unitedShapeOfLayers([layer]);
        if (!worldShape) throw new Error('Could not calculate bounding shape');

        const unionW = worldShape.rect.w;
        const unionH = worldShape.rect.h;
        const { x: unionCx, y: unionCy } = geometry.space.getRectCenter(worldShape.rect);

        // Pre-rasterize text/color layers to ensure the Worker has valid bitmaps to composite
        const [rasterizedLayer] = await preRasterizeLayers([layer], pixels);

        const targetDpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
        const assetResult = await pixels.worker.asAsset(
          pixels.worker.mergeLayersWithShape([rasterizedLayer], worldShape, { targetDpr })
        );

        if (!assetResult) throw new Error('Rasterize failed');

        layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(layer.id)
            .setAsset(assetResult)
            .resetWithBounds(unionW, unionH, unionCx, unionCy);
        });

        // After rasterization, the layer becomes a pure bitmap, and specific text/color data and bitmapMasks (already baked into the bitmap) need to be cleared
        actions.updateLayer(activeFrame.id, layer.id, {
          type: 'image',
          textData: undefined,
          bitmapMasks: [],
        });

      } catch (err) {
        console.error('[LayerPanel] Rasterize failed:', err);
        actions.setInteraction({ hud: { message: 'Rasterize failed.', type: 'error' } });
      }
    }
  } as EditorCommand<{ layerId?: string }, Promise<void>>
};
