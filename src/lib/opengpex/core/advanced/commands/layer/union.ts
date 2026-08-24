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

/**
 * union.ts — Logical Union Merge command.
 *
 * Computes the geometric union of N fragment layers' visibleShapes,
 * producing a new merged layer with zero rasterization.
 *
 */

import { EditorContextValue, EditorCommand, Layer, VectorMask, asLocalShape } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';
import { shapeToPoint2D } from '@opengpex/editor/core/geometry/operators/point2d';
import { unionRings } from '@opengpex/editor/core/geometry/poly-clip';
import { LayerFactory, findUpstreamAssetId, findDownstreamFragments } from '@opengpex/editor/core/layer/factory';

interface UnionMergePayload {
  layerIds: string[];
}

export const LayerUnionCommands = {
  unionMerge: {
    id: P.ADV_LAYER_UNION_MERGE,
    name: 'Union Merge Fragments',
    undoable: true,
    execute: (ctx: EditorContextValue, payload?: UnionMergePayload): void => {
      const { activeFrame, layers, actions, geometry } = ctx;
      if (!activeFrame || !payload?.layerIds || payload.layerIds.length < 2) return;

      const layerIds = payload.layerIds;
      const targetLayers = layerIds
        .map(id => activeFrame.layers.byId[id])
        .filter(Boolean) as Layer[];

      if (targetLayers.length < 2) {
        actions.setInteraction({ hud: { message: 'Need at least 2 valid layers to union merge.', type: 'error' } });
        return;
      }

      // ═══ Phase 1: Validation ═══

      // Check all are image type
      const nonImage = targetLayers.find(l => l.type !== 'image');
      if (nonImage) {
        actions.setInteraction({ hud: { message: 'Union merge only works on image layers.', type: 'error' } });
        return;
      }

      // Resolve root assetIds and ensure they match
      const assetIds = targetLayers.map(l => findUpstreamAssetId(l.id, activeFrame));
      if (assetIds.some(id => !id)) {
        actions.setInteraction({ hud: { message: 'Cannot resolve source asset for one or more layers.', type: 'error' } });
        return;
      }
      const uniqueAssetIds = [...new Set(assetIds)];
      if (uniqueAssetIds.length > 1) {
        actions.setInteraction({ hud: { message: 'Cannot union merge layers from different source images.', type: 'error' } });
        return;
      }

      // Guard: rotation and flip consistency
      const baseLayer = targetLayers[0];
      const rotationMismatch = targetLayers.some(l => l.rotation !== baseLayer.rotation);
      const flipMismatch = targetLayers.some(l => l.flip.h !== baseLayer.flip.h || l.flip.v !== baseLayer.flip.v);
      if (rotationMismatch || flipMismatch) {
        actions.setInteraction({ hud: { message: 'Cannot union merge layers with different rotation/flip.', type: 'error' } });
        return;
      }

      // Guard: downstream fragments of selected layers must all be within the selection.
      // If a selected layer has unselected downstream, merging would orphan those fragments.
      const allLayers = activeFrame.layers.order.map(id => activeFrame.layers.byId[id]);
      const selectionSet = new Set(layerIds);
      for (const layer of targetLayers) {
        const downstream = findDownstreamFragments(layer.id, allLayers);
        const unselected = downstream.filter(d => !selectionSet.has(d.id));
        if (unselected.length > 0) {
          actions.setInteraction({ hud: { message: `Layer "${layer.name}" has downstream fragments not included in selection.`, type: 'error' } });
          return;
        }
      }

      // ═══ Phase 2: Collect rings from visibleShapes ═══
      const ringSets = targetLayers.map(l => {
        if (!l.visibleShape) {
          // Fallback: treat full bounding as rect shape
          const fallbackShape = asLocalShape({ x: 0, y: 0, w: l.bounding.w, h: l.bounding.h });
          return shapeToPoint2D(fallbackShape);
        }
        return shapeToPoint2D(l.visibleShape);
      });

      // ═══ Phase 3: Geometric Union ═══
      const unionResult = unionRings(...ringSets);
      if (!unionResult) {
        actions.setInteraction({ hud: { message: 'Geometric union failed. Shapes may be degenerate.', type: 'error' } });
        return;
      }

      // ═══ Phase 4: Construct new merged layer ═══
      try {
        const newLayer = LayerFactory.getNewLayer({
          src: baseLayer.src,
          assetId: baseLayer.assetId,
          type: 'image',
          rotation: baseLayer.rotation,
          flip: { ...baseLayer.flip },
          adjustments: baseLayer.adjustments ? { ...baseLayer.adjustments } : undefined,
          opacity: baseLayer.opacity,
          blendMode: baseLayer.blendMode,
          vectorMasks: baseLayer.vectorMasks?.filter(m => !m.assocLayerId) || [],
          bitmapMasks: baseLayer.bitmapMasks || [],
          name: baseLayer.name,
          visibleShape: { ...asLocalShape(unionResult.rect, 'path'), pathData: unionResult.pathData },
          bounding: { w: unionResult.rect.w, h: unionResult.rect.h },
          metadata: { physicalPixels: false },
        });

        // Compute cx, cy using the world matrix of the base layer
        const wm = geometry.transform.getLayerWorldMatrix(baseLayer);
        const rectCenterX = unionResult.rect.x + unionResult.rect.w / 2;
        const rectCenterY = unionResult.rect.y + unionResult.rect.h / 2;
        const worldCenter = {
          x: wm.a * rectCenterX + wm.c * rectCenterY + wm.tx,
          y: wm.b * rectCenterX + wm.d * rectCenterY + wm.ty,
        };
        const pose = geometry.transform.computeFragmentCenter(
          worldCenter,
          { x: unionResult.rect.x, y: unionResult.rect.y },
          baseLayer.rotation,
          baseLayer.flip
        );
        newLayer.cx = pose.x;
        newLayer.cy = pose.y;
        newLayer.birthCenter = { cx: newLayer.cx, cy: newLayer.cy };

        // ═══ Phase 5: Cut-Link metadata handling ═══
        // Collect all cut-link pointers from the target layers.
        const deletingIds = new Set(targetLayers.map(l => l.id));
        const sourceLayerIds = new Set<string>();
        const maskIdsToRemoveBySource = new Map<string, Set<string>>(); // sourceId → mask ids

        for (const layer of targetLayers) {
          const sourceId = layer.metadata?.sourceLayerId as string | undefined;
          const maskId = layer.metadata?.assocMaskId as string | undefined;
          if (sourceId && maskId) {
            sourceLayerIds.add(sourceId);
            if (!maskIdsToRemoveBySource.has(sourceId)) maskIdsToRemoveBySource.set(sourceId, new Set());
            maskIdsToRemoveBySource.get(sourceId)!.add(maskId);
          }
        }

        // Scenario D: All fragments are copies (no assocMaskId) — retain sourceLayerId for lineage.
        if (sourceLayerIds.size === 0) {
          const copySourceIds = new Set(
            targetLayers.map(l => l.metadata?.sourceLayerId as string | undefined).filter(Boolean)
          );
          if (copySourceIds.size === 1) {
            newLayer.metadata = {
              ...newLayer.metadata,
              sourceLayerId: [...copySourceIds][0],
            };
          }
        }

        // Find the surviving ancestor — the first source in the chain NOT being deleted.
        // This handles both Scenario A (same source, 1 hop) and Scenario B (cross-level, N hops).
        let survivingAncestorId: string | null = null;
        if (sourceLayerIds.size > 0) {
          const visited = new Set<string>();
          for (const sourceId of sourceLayerIds) {
            let current: string | undefined = sourceId;
            while (current) {
              if (visited.has(current)) break;
              visited.add(current);
              if (!deletingIds.has(current)) {
                survivingAncestorId = current;
                break;
              }
              const layer = activeFrame.layers.byId[current];
              current = layer?.metadata?.sourceLayerId as string | undefined;
            }
            if (survivingAncestorId) break;
          }
        }

        // Prepare definitive masks for the surviving ancestor (written AFTER removeLayers).
        let finalSourceMasks: VectorMask[] | undefined;
        if (survivingAncestorId) {
          const ancestor = activeFrame.layers.byId[survivingAncestorId];
          if (ancestor) {
            const newMaskId = `mask-hole-${newLayer.id}`;
            const holeMaskShape = { ...asLocalShape(unionResult.rect, 'path'), pathData: unionResult.pathData };
            const newHoleMask = LayerFactory.getNewVectorMask(holeMaskShape, {
              inverted: true,
              assocLayerId: newLayer.id,
              maskId: newMaskId,
            });

            // Collect ALL mask ids that should be removed from this ancestor.
            // Only masks pointing to layers being deleted (directly associated).
            const masksToRemoveFromAncestor = maskIdsToRemoveBySource.get(survivingAncestorId) || new Set();

            // Single atomic operation: remove old hole masks + append new union mask
            finalSourceMasks = [
              ...(ancestor.vectorMasks || []).filter(m => !masksToRemoveFromAncestor.has(m.id)),
              newHoleMask,
            ];

            newLayer.metadata = {
              ...newLayer.metadata,
              sourceLayerId: survivingAncestorId,
              assocMaskId: newMaskId,
            };
          }
        }

        // ═══ Phase 6: Commit — remove old layers, add merged layer ═══
        // IMPORTANT: Remove fragment layers FIRST. The removeLayers cleanup hook
        // auto-removes their hole masks from the source. THEN we write the definitive
        // source vectorMasks state (our write is LAST and overwrites the hook's work).
        layers.addLayer(activeFrame.id, newLayer);

        // Remove original fragment layers (cleanup hooks remove their old hole masks)
        for (const layer of targetLayers) {
          layers.removeLayers(activeFrame.id, layer.id);
        }

        // ═══ Phase 7: Write definitive source masks AFTER removeLayers ═══
        // This MUST happen last to prevent the cut-link cleanup hook from overwriting
        // our union mask with stale state. Our write is the final authority.
        if (survivingAncestorId && finalSourceMasks) {
          actions.updateLayer(activeFrame.id, survivingAncestorId, { vectorMasks: finalSourceMasks });
        }

        // Activate the new merged layer
        layers.activate(activeFrame.id, newLayer.id);

        actions.setInteraction({ hud: { message: `Merged ${targetLayers.length} fragments.`, type: 'success' } });

      } catch (err) {
        console.error('[UnionMerge] Failed:', err);
        actions.setInteraction({ hud: { message: 'Union merge failed.', type: 'error' } });
      }
    }
  } as EditorCommand<UnionMergePayload, void>,
};
