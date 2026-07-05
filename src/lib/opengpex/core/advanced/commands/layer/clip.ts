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

import { EditorContextValue, EditorCommand, ClipboardLayerMetadata, LocalShape, asLocalRect } from '@opengpex/editor/core/types';
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
      const { activeFrame, activeLayer, geometry, clipboard, state, actions } = ctx;

      try {
        // ═══ Step 1: Read clipboard content first (before any frame check) ═══
        let meta: ClipboardLayerMetadata | undefined = (payload && 'assetId' in payload) ? payload : undefined;
        const event = (payload && 'e' in payload) ? payload.e : undefined;
        let blob: Blob | undefined = undefined;

        if (!meta) {
          const res = await clipboard.read(event);
          meta = res?.metadata;
          blob = res?.blob;
        }

        // Nothing useful in clipboard — abort
        if (!meta && !blob) return;

        // ═══ Step 2: No active frame — create a new frame from clipboard image ═══
        if (!activeFrame) {
          if (blob) {
            const file = new File(
              [blob],
              `Pasted Image ${new Date().toLocaleTimeString()}.png`,
              { type: blob.type || 'image/png' }
            );
            await actions.adv.frame.create.trunk.execute({ source: file });
          } else if (meta?.layer?.src) {
            // Internal clipboard with no active frame (edge case)
            await actions.adv.frame.create.trunk.execute({ source: meta.layer.src });
          }
          return;
        }

        // ═══ Step 3: Active frame exists + external image → ask user choice ═══
        if (!meta?.layer && blob) {
          const choice = await actions.askChoice("Paste Image", [
            { id: 'layer', label: 'New Layer', description: 'Add to current creation as a new layer', icon: 'Layers', iconGradient: 'from-indigo-500 to-purple-600' },
            { id: 'frame', label: 'New Frame', description: 'Start a brand-new independent creation', icon: 'PlusSquare', iconGradient: 'from-amber-500 to-orange-600' },
          ]);

          if (choice === null) return; // User cancelled (X button or Escape)

          if (choice === 'frame') {
            const file = new File(
              [blob],
              `Pasted Image ${new Date().toLocaleTimeString()}.png`,
              { type: blob.type || 'image/png' }
            );
            await actions.adv.frame.create.trunk.execute({ source: file });
            return;
          }
          // choice === 'layer' → fall through to "add as layer" logic below
        }

        // ═══ Step 4: Add as layer (existing behavior) ═══
        let newLayer;

        if (meta?.layer) {
          // Internal Paste (contains full layer object)
          // New layers must never inherit lock/interactive state from the source
          const { id: _oldId, locked: _locked, interactive: _inter, ...layerWithoutId } = meta.layer;
          const smartName = ctx.layers.getNewLayerName(activeFrame.layers.order.map(id => activeFrame.layers.byId[id]), 'Layer');

          const vDim = state.ui.viewportDim;
          const worldCenter = geometry.space.screenToWorld(vDim.w / 2, vDim.h / 2, activeFrame);

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
          // External Image Paste (Blob)
          newLayer = await ctx.layers.createLayerFromBlob(blob, activeFrame);
        } else {
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
    name: 'Apply as Layer Mask',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: { layerId?: string; feather?: number }): Promise<void> => {
      const { activeFrame, activeLayer, actions, geometry, layers, pixels } = ctx;
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

      // Read feather radius from payload (0 = no feather)
      const feather = payload?.feather ?? 0;

      if (box.regular) {
        // ═══ Regular selection (rect/ellipse) → Vector Mask ═══
        // Lightweight, geometrically precise, scalable without quality loss.
        const localShape: LocalShape = box.spatial;
        layers.updateLayer(activeFrame.id, tx => {
          tx.edit(targetLayer.id).applyMask(localShape, false, feather);
        });
      } else {
        // ═══ Irregular selection (lasso/wand/AI) → Bitmap Mask ═══
        // Complex edges benefit from pixel-level representation; enables future brush refinement.
        const layerPoly = geometry.polygon.frameLocalToLayerLocal(box.spatial, activeFrame, targetLayer);

        const maskAsset = await pixels.rasterize.mask(layerPoly, targetLayer.bounding, feather);
        if (!maskAsset) {
          actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        layers.updateLayer(activeFrame.id, tx => {
          tx.edit(targetLayer.id).applyBitmapMask(
            maskAsset.url,
            maskAsset.id,
            asLocalRect({ x: 0, y: 0, w: targetLayer.bounding.w, h: targetLayer.bounding.h })
          );
        });
      }

      // NOTE: Selection is intentionally preserved after applying mask.
      // The user may want to apply the same selection to other layers,
      // continue refining, or use it for further operations. This matches
      // the `drill` command's behavior and the Photoshop convention where
      // masks are non-destructive to selections. Users can explicitly clear
      // via "Clear Selection" (double-click / resetBox command) if desired.
    },
  } as EditorCommand<{ layerId?: string; feather?: number } | undefined, Promise<void>>,

  drill: {
    id: P.ADV_LAYER_CLIP_DRILL,
    name: 'Delete Selection',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: { feather?: number }): Promise<void> => {
      const { activeFrame, activeLayer, actions, geometry, assets } = ctx;
      const isClipActive = ctx.state.interaction.interactionMode === 'clip';
      if (!activeFrame || !activeLayer || !isClipActive) return;

      try {
        const latestLayer = actions.fast.latestLayer(activeFrame.id, activeLayer.id) || activeLayer;

        const box = getClipBox(activeFrame);
        if (!box) return;

        const feather = payload?.feather ?? 0;
        const w = Math.ceil(latestLayer.bounding.w);
        const h = Math.ceil(latestLayer.bounding.h);
        if (w <= 0 || h <= 0) return;

        // ═══ Merged Drilled BitmapMask: find or create ═══
        const existingMasks = latestLayer.bitmapMasks || [];
        const drilledMask = existingMasks.find(m => m.tag === 'drilled');

        // Create OffscreenCanvas for mask composition
        const maskCanvas = new OffscreenCanvas(w, h);
        const maskCtx = maskCanvas.getContext('2d')!;

        if (drilledMask) {
          // Load existing drilled mask image
          const response = await fetch(drilledMask.src);
          const blob = await response.blob();
          const img = await createImageBitmap(blob);
          maskCtx.drawImage(img, 0, 0, w, h);
        } else {
          // Start with full white (alpha=255 everywhere = all visible)
          maskCtx.fillStyle = '#ffffff';
          maskCtx.fillRect(0, 0, w, h);
        }

        // Punch hole using destination-out composite
        maskCtx.globalCompositeOperation = 'destination-out';

        if (!box.regular) {
          // Irregular selection → polygon path
          const layerPoly = geometry.polygon.frameLocalToLayerLocal(box.spatial, activeFrame, latestLayer);
          const path = new Path2D();
          for (const ring of layerPoly.rings) {
            if (ring && ring.length > 0) {
              path.moveTo(ring[0].x, ring[0].y);
              for (let i = 1; i < ring.length; i++) {
                path.lineTo(ring[i].x, ring[i].y);
              }
              path.closePath();
            }
          }

          if (feather > 0) {
            const holeCanvas = new OffscreenCanvas(w, h);
            const holeCtx = holeCanvas.getContext('2d')!;
            holeCtx.fillStyle = '#ffffff';
            holeCtx.fill(path, 'evenodd');
            const blurCanvas = new OffscreenCanvas(w, h);
            const blurCtx = blurCanvas.getContext('2d')!;
            blurCtx.filter = `blur(${feather}px)`;
            blurCtx.drawImage(holeCanvas, 0, 0);
            maskCtx.drawImage(blurCanvas, 0, 0);
          } else {
            maskCtx.fillStyle = '#ffffff';
            maskCtx.fill(path, 'evenodd');
          }
        } else {
          // Regular selection → rect/ellipse shape
          const localShape = geometry.shape.frameLocalToLayerLocal(box.spatial, activeFrame, latestLayer);
          const { x, y, w: sw, h: sh } = localShape.rect;

          if (feather > 0) {
            const holeCanvas = new OffscreenCanvas(w, h);
            const holeCtx = holeCanvas.getContext('2d')!;
            holeCtx.fillStyle = '#ffffff';
            if (localShape.type === 'circle') {
              holeCtx.beginPath();
              holeCtx.ellipse(x + sw / 2, y + sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
              holeCtx.fill();
            } else {
              holeCtx.fillRect(x, y, sw, sh);
            }
            const blurCanvas = new OffscreenCanvas(w, h);
            const blurCtx = blurCanvas.getContext('2d')!;
            blurCtx.filter = `blur(${feather}px)`;
            blurCtx.drawImage(holeCanvas, 0, 0);
            maskCtx.drawImage(blurCanvas, 0, 0);
          } else {
            maskCtx.fillStyle = '#ffffff';
            if (localShape.type === 'circle') {
              maskCtx.beginPath();
              maskCtx.ellipse(x + sw / 2, y + sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
              maskCtx.fill();
            } else {
              maskCtx.fillRect(x, y, sw, sh);
            }
          }
        }

        // Export drilled mask as PNG and register in asset service
        const blob = await maskCanvas.convertToBlob({ type: 'image/png' });
        const assetId = await assets.register(blob);
        const url = assets.getURL(assetId);
        if (!url) return;

        // Update existing drilled mask or create new one
        if (drilledMask) {
          ctx.layers.updateLayer(activeFrame.id, tx => {
            tx.edit(latestLayer.id).updateBitmapMask(drilledMask.id, { src: url, assetId });
          });
        } else {
          // Create new BitmapMask with tag='drilled'
          const newMask = {
            id: `bmask-drilled-${Date.now()}`,
            src: url,
            assetId,
            bounds: asLocalRect({ x: 0, y: 0, w, h }),
            inverted: false,
            enabled: true,
            feather: 0,
            tag: 'drilled',
          };
          ctx.layers.updateLayer(activeFrame.id, tx => {
            tx.edit(latestLayer.id).patch({ bitmapMasks: [newMask, ...existingMasks] });
          });
        }

        // NOTE: Selection is intentionally preserved after drill.
        // Unlike toMask (which is a "finalize" operation), drill is an
        // editing action — the user expects the marching ants to remain
        // so they can drill again, switch layers, or continue editing
        // with the same selection. This matches Photoshop's Delete behavior.
      } catch (err) {
        console.error('[ClipCommands] Drill selection failed:', err);
      }
    },
  } as EditorCommand<{ feather?: number } | undefined, Promise<void>>
};
