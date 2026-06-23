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

import { EditorContextValue, EditorCommand, asLocalRect } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * IRREGULAR_SELECTION_COMMANDS
 *
 * Phase 1 irregular-selection (lasso / wand / AI matting) command set.
 *
 * Pre-PR-6-2 architecture:
 *   - Producers (lasso handler / wand handler / AI matting result) write
 *     `irregularCropBox` directly via `actions.setIrregularCropBox(frameId, polygon)`,
 *     symmetric with rect/ellipse writing `imageCropBox` / `canvasCropBox`.
 *   - There is NO `set` / `clear` adv command — those would be value-less thin
 *     wrappers around the action; the executeCommand atom only buys you a
 *     pre-execute history checkpoint, but `actions.setIrregularCropBox` already
 *     gets one from the dispatcher's standard reducer pipeline. See
 *     `phase1_irregular_clip_spec.md` §6 Pre-PR-6-2.0 for full rationale.
 *   - The only command in this file is `toLayerMask`, which IS a real
 *     transaction (project + bake offscreen mask + addBitmapMask + clear) and
 *     therefore needs the undo-atom guarantee.
 *
 * Lifecycle:
 *   1) Producer writes polygon  → `actions.setIrregularCropBox(frameId, polygon)`
 *   2) ClipOverlay reads it via `useIrregularSelectionSync` for purple ants preview
 *   3) User clicks "Apply Mask" → `toLayerMask` (this command)
 *   4) Switching tool / cancel / re-canvas → no automatic clear; data persists
 *      across tool switches for round-trip symmetry. The only paths that clear
 *      `irregularCropBox` are (a) `toLayerMask` itself (after baking) and
 *      (b) a future explicit "Clear Selection" user gesture (not in Phase 1).
 *
 * Atomicity:
 *   The runtime sets a history checkpoint BEFORE every `undoable: true` command.
 *   All state mutations made INSIDE the command (without going through another
 *   `executeCommand`-driven undoable) end up in the same edit step at the next
 *   commit. We therefore deliberately call `actions.updateLayer` and
 *   `actions.setIrregularCropBox` directly (NOT via `adv.layer.bitmapMask.add`),
 *   to avoid nested SIGNAL_COMMITs splitting the atom.
 */
export const IrregularSelectionCommands = {
  toLayerMask: {
    id: P.ADV_IRREGULAR_TO_LAYER_MASK,
    name: 'Apply Selection as Layer Mask',
    undoable: true,
    execute: (ctx: EditorContextValue, payload?: { layerId?: string }): Promise<void> => {
      const { assets } = ctx;
      return assets.withSession(async () => {
        const { activeFrame, activeLayer, actions, geometry } = ctx;
        if (!activeFrame) return;

        const polygon = activeFrame.irregularCropBox;
        if (!polygon || !polygon.rings.length) {
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

        try {
          // 1. Project polygon: frame-local → layer-local
          const layerPoly = geometry.polygon.frameLocalToLayerLocalPolygon(polygon, activeFrame, targetLayer);

          // 2. Compute offscreen canvas geometry with 1-px safety padding on each side.
          //    BitmapMask.bounds is the rect in layer-local space at which the canvas image is placed.
          const PAD = 1;
          const canvasW = Math.max(1, Math.ceil(layerPoly.bounds.w) + PAD * 2);
          const canvasH = Math.max(1, Math.ceil(layerPoly.bounds.h) + PAD * 2);

          const canvas = document.createElement('canvas');
          canvas.width = canvasW;
          canvas.height = canvasH;
          const c2d = canvas.getContext('2d');
          if (!c2d) {
            console.error('[IrregularSelection] Failed to acquire 2D context for mask canvas');
            return;
          }

          // 3. Render mask: black background, white polygon (evenodd for multi-ring holes)
          c2d.fillStyle = '#000000';
          c2d.fillRect(0, 0, canvasW, canvasH);

          const ox = layerPoly.bounds.x - PAD;
          const oy = layerPoly.bounds.y - PAD;

          const path = new Path2D();
          for (const ring of layerPoly.rings) {
            if (ring.length < 3) continue;
            path.moveTo(ring[0].x - ox, ring[0].y - oy);
            for (let i = 1; i < ring.length; i++) {
              path.lineTo(ring[i].x - ox, ring[i].y - oy);
            }
            path.closePath();
          }
          c2d.fillStyle = '#ffffff';
          c2d.fill(path, 'evenodd');

          // 4. Encode as PNG Blob → register asset
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob((b) => resolve(b), 'image/png')
          );
          if (!blob) {
            console.error('[IrregularSelection] Failed to encode mask canvas to PNG blob');
            return;
          }

          const assetId = await assets.register(blob);
          const assetUrl = assets.getURL(assetId);
          if (!assetUrl) {
            console.error('[IrregularSelection] Asset URL not found after registration');
            return;
          }

          const bounds = asLocalRect({
            x: layerPoly.bounds.x - PAD,
            y: layerPoly.bounds.y - PAD,
            w: canvasW,
            h: canvasH,
          });

          // 5. Append BitmapMask to target layer (direct dispatch — share undo atom)
          const newMask = LayerFactory.getNewBitmapMask(assetUrl, assetId, bounds);
          actions.updateLayer(activeFrame.id, targetLayer.id, {
            bitmapMasks: [...(targetLayer.bitmapMasks || []), newMask],
          });

          // 6. Clear the irregular selection (also shares the same undo atom)
          actions.setIrregularCropBox(activeFrame.id, null);
        } catch (err) {
          console.error('[IrregularSelection] toLayerMask failed:', err);
        }
      });
    },
  } as EditorCommand<{ layerId?: string } | undefined, Promise<void>>,
};
