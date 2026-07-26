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

// ─── Shared composite helper ────────────────────────────────────────────────
/**
 * compositeLayersToAsset — Delegates to `pixels.render.compositeLayers()` to
 * compute the union shape and composite, then injects the result as an asset.
 * Returns the asset reference and the computed union geometry.
 */
async function compositeLayersToAsset(
  layers: Layer[],
  ctx: Pick<EditorContextValue, 'pixels' | 'assets' | 'activeFrame'>,
) {
  const { pixels, activeFrame } = ctx;
  if (!activeFrame) throw new Error('No active frame');

  const { result, bounds } = await pixels.render.compositeLayers(layers, activeFrame);

  const asset = await result.toAsset();
  if (!asset.id) throw new Error('Composite failed');

  // Ensure bitmap is decoded into SourceBitmapCache before state update.
  // toAsset() triggers warmFromBlob via onRegistered but fire-and-forget;
  // await here guarantees the next render frame won't cache-miss and flicker.
  const blob = await result.toBlob();
  await pixels.image.cacheBitmap(asset.url, blob);

  return { asset, bounds };
}

/**
 * LayerMergeCommands: Advanced layer merge commands.
 *
 * Step 8 migration: All merge/rasterize operations now use the unified
 * `pixels.composite()` pipeline instead of the old scattered APIs:
 *   - pixels.worker.mergeLayersWithShape → pixels.composite()
 *   - pixels.render.flattenLayers → pixels.composite()
 *   - preRasterizeLayers → handled internally by pipeline's IStrategyResolver
 *
 * The pipeline internally resolves layer strategies (text/color/bitmap/raw),
 * selects the best backend (Canvas2D 8-bit / HighDepth 16-bit), and produces
 * a CompositeResult. Asset injection uses result.toAsset() which delegates
 * to the injected assetInjector wired by PixelService.
 *
 * @see docs/opengpex/plans/20260721_unified_composite_pipeline_design.md §14 Step 8
 */
export const LayerMergeCommands = {
  mergeDown: {
    id: P.ADV_LAYER_MERGE_DOWN,
    name: 'Merge Layer Down',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<void> => {
      const { activeFrame, activeLayer, layers, actions } = ctx;
      if (!activeFrame || !activeLayer) return;

      const hostLayers = layers.getHostLayers(activeFrame.layers.order.map(id => activeFrame.layers.byId[id]));
      const activeIndex = hostLayers.findIndex(l => l.id === activeLayer.id);

      if (activeIndex === 0) {
        actions.setInteraction({ hud: { message: 'Cannot merge down. This is the bottom-most layer.', type: 'error' } });
        return;
      }

      const targetLayer = hostLayers[activeIndex - 1];


      try {
        const { asset: assetResult, bounds } = await compositeLayersToAsset(
          [targetLayer, activeLayer], ctx,
        );

        layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(targetLayer.id)
            .setAsset(assetResult)
            .resetWithBounds(bounds.w, bounds.h, bounds.cx, bounds.cy);
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
      const { activeFrame, layers, actions } = ctx;
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
        const { asset: assetResult, bounds } = await compositeLayersToAsset(
          visibleLayers, ctx,
        );

        layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(targetLayer.id)
            .setAsset(assetResult)
            .resetWithBounds(bounds.w, bounds.h, bounds.cx, bounds.cy);
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
      const { activeFrame, layers, actions } = ctx;
      if (!activeFrame) return;

      const layerId = payload?.layerId || ctx.activeLayer?.id;
      if (!layerId) return;

      const layer = activeFrame.layers.byId[layerId];
      if (!layer) return;

      try {
        const { asset: assetResult, bounds } = await compositeLayersToAsset(
          [layer], ctx,
        );

        layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(layer.id)
            .setAsset(assetResult)
            .resetWithBounds(bounds.w, bounds.h, bounds.cx, bounds.cy);
        });

        // After rasterization, the layer becomes a pure bitmap — all non-destructive
        // effects (masks, adjustments) are now baked into the pixel data and must be
        // cleared to prevent double-application during rendering.
        actions.updateLayer(activeFrame.id, layer.id, {
          type: 'image',
          textData: undefined,
          bitmapMasks: [],
          vectorMasks: [],
          adjustments: undefined,
        });

      } catch (err) {
        console.error('[LayerPanel] Rasterize failed:', err);
        actions.setInteraction({ hud: { message: 'Rasterize failed.', type: 'error' } });
      }
    }
  } as EditorCommand<{ layerId?: string }, Promise<void>>
};
