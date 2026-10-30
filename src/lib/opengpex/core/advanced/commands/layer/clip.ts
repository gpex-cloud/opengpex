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

import { EditorContextValue, EditorCommand, ClipboardLayerMetadata } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { polygonToShape } from '@opengpex/editor/core/geometry/operators/polygon';
import * as P from '@opengpex/editor/core/advanced/protocols';
import { computeFragmentCenter } from '@opengpex/editor/core/geometry/operators/transform';
import { LayerUtils } from '@opengpex/editor/core/layer/utils';
import { createFrameFromAsset } from '../frame/importers';

/**
 * Extract common logic of Cut and Copy: generate physical fragment and write to clipboard.
 * Caller must pass an already-resolved non-null `selection`.
 *
 * @param mode - 'copy' (default) or 'cut'. When 'cut', the returned result includes
 *   `sourceHole` so callers can punch a hole in the source layer.
 */
async function copyCropBoxToClipboard(
  ctx: EditorContextValue,
  mode: 'copy' | 'cut' = 'copy'
) {
  const { activeFrame, activeLayer, actions } = ctx;
  if (!activeFrame || !activeLayer) return null;

  const latestLayer = actions.fast.latestLayer(activeFrame.id, activeLayer.id) || activeLayer;

  // 1. Physical blob: always needed for external clipboard (WeChat, Word, etc.)
  const physicalResult = await ctx.layers.fragmentToNewLayerPhysical(activeFrame, latestLayer);
  if (!physicalResult) {
    actions.setInteraction({
      hud: { message: 'Area is empty', type: 'error' }
    });
    return null;
  }

  // 2. Preferred layer via unified strategy: lossless logical layer when possible,
  //    falls back to physical. Also provides sourceHole for correct cut hole.
  const preferredResult = await ctx.layers.fragmentToNewLayer(activeFrame, latestLayer, { mode });

  // 3. Composite clipboard write: external software reads physicalResult.url (Blob),
  //    internal Paste command reads Metadata.layer (preferred strategy result)
  await ctx.clipboard.writeByUrl(physicalResult.url, {
    layer: preferredResult ? preferredResult.newLayer : physicalResult.newLayer,
    sourceFrameId: activeFrame.id,
  });

  return {
    ...physicalResult,
    newLayer: preferredResult ? preferredResult.newLayer : physicalResult.newLayer,
    invertedRegular: preferredResult?.invertedRegular ?? false,
    holeMask: preferredResult?.holeMask,
  };
}


/**
 * CLIP_COMMANDS: Core clip and selection commands (Cut, Copy, Paste)
 */
export const LayerClipCommands = {
  copy: {
    id: P.ADV_LAYER_CLIP_COPY,
    name: 'Copy',
    category: 'Clipboard',
    execute: (ctx: EditorContextValue): Promise<void> => {
      const { assets } = ctx;
      return assets.withSession(async () => {
        const { activeFrame, activeLayer, actions, state } = ctx;
        const isClipMode = state.interaction.interactionMode === 'clip';

        if (!activeFrame || !activeLayer || !isClipMode || activeLayer.type !== 'image') {
          actions.setInteraction({
            hud: { message: 'No editable layer selected', type: 'error' }
          });
          return;
        }

        try {
          const box = getClipBox(activeFrame);

          if (box) {
            await copyCropBoxToClipboard(ctx);
          } else {
            // Without selection: copy the entire layer
            await ctx.clipboard.writeByUrl(activeLayer.src, {
              layer: activeLayer,
              sourceFrameId: activeFrame.id,
            });
          }
        } catch (err) {
          console.error('[ClipCommands] Copy operation failed:', err);
        }
      });
    },
    shortcuts: [{ key: 'c', meta: true }, { key: 'c', ctrl: true }]
  } as EditorCommand<void, Promise<void>>,

  cut: {
    id: P.ADV_LAYER_CLIP_CUT,
    name: 'Cut',
    category: 'Clipboard',
    undoable: true,
    execute: (ctx: EditorContextValue): Promise<void> => {
      const { assets } = ctx;
      return assets.withSession(async () => {
        const { activeFrame, activeLayer, actions, state } = ctx;
        const isClipMode = state.interaction.interactionMode === 'clip';

        const latestLayer = (activeFrame && activeLayer)
          ? (actions.fast?.latestLayer?.(activeFrame.id, activeLayer.id) || activeLayer)
          : null;

        if (!activeFrame || !latestLayer || !isClipMode || latestLayer.type !== 'image') {
          actions.setInteraction({
            hud: { message: 'No editable layer selected', type: 'error' }
          });
          return;
        }

        if (latestLayer.locked) {
          actions.setInteraction({
            hud: { message: 'Layer is locked', type: 'error' }
          });
          return;
        }

        try {
          const box = getClipBox(activeFrame);

          if (box) {
            const result = await copyCropBoxToClipboard(ctx, 'cut');
            if (!result) return;

            // Punch hole using pre-computed holeMask descriptor
            if (result.holeMask) {
              const { shape, inverted, assocLayerId, feather: maskFeather, maskId } = result.holeMask;
              ctx.layers.updateLayer(activeFrame.id, tx => {
                tx.edit(latestLayer.id)
                  .applyMask(shape, { maskId, assocLayerId, inverted, feather: maskFeather });
              });
            }

          } else {
            // Without selection: cut the entire layer (clear content, keep layer)
            await ctx.clipboard.writeByUrl(latestLayer.src, {
              layer: latestLayer,
              sourceFrameId: activeFrame.id,
            });

            ctx.layers.updateLayer(activeFrame.id, tx => {
              tx.edit(latestLayer.id).maskLayer();
            });
          }
        } catch (err) {
          console.error('[ClipCommands] Cut operation failed:', err);
        }
      });
    },
    shortcuts: [{ key: 'x', meta: true }, { key: 'x', ctrl: true }]
  } as EditorCommand<void, Promise<void>>,

  paste: {
    id: P.ADV_LAYER_CLIP_PASTE,
    name: 'Paste',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: ClipboardLayerMetadata | { e?: ClipboardEvent }): Promise<void> => {
      const { activeFrame, activeLayer, clipboard, actions, state } = ctx;

      try {
        // ═══ Step 1: Read clipboard → always returns { metadata?, blob? } ═══
        let meta: ClipboardLayerMetadata | undefined = (payload && 'assetId' in payload) ? payload : undefined;
        const event = (payload && 'e' in payload) ? payload.e : undefined;
        let blob: Blob | undefined = undefined;

        if (!meta) {
          const res = await clipboard.read(event);
          meta = res?.metadata;
          blob = res?.blob;
        }

        // Neither metadata nor blob available → abort
        if (!meta && !blob) return;

        // ═══ Step 2: Adjudicate the paste target ═══
        // No open frame → the only destination is a new frame (silent).
        // Same-frame copy → a new layer pasted in place, no dialog.
        // Cross-frame / external → the user picks the destination.
        const sourceLayer = meta?.layer;
        const sourceFrame = meta?.sourceFrameId ? state.frames.byId[meta.sourceFrameId] : undefined;
        const isSameFrame = !!(sourceLayer && meta!.sourceFrameId === activeFrame?.id);
        let target: 'layer' | 'frame';
        if (!activeFrame) {
          target = 'frame';
        } else if (isSameFrame) {
          target = 'layer';
        } else {
          const choice = await actions.askChoice("Paste Image", [
            { id: 'layer', label: 'New Layer', description: 'Add to current creation as a new layer', icon: 'Layers', iconGradient: 'from-indigo-500 to-purple-600' },
            { id: 'frame', label: 'New Frame', description: 'Start a brand-new independent creation', icon: 'PlusSquare', iconGradient: 'from-amber-500 to-orange-600' },
          ]);
          if (choice === null) return; // User cancelled
          target = choice as 'layer' | 'frame';
        }

        // ═══ Step 3A: Paste as a new frame ═══
        // High-fidelity first: an image layer with a crop window REFERENCES the
        // original asset (bit depth / gamut ride along) — the cold start (no
        // open frame) and cross-frame destinations share this path. Falls back
        // to the 8-bit PNG when the asset cannot be resolved.
        if (target === 'frame') {
          const source = sourceLayer?.type === 'image' ? sourceLayer : undefined;
          if (source?.visibleShape && source.assetId) {
            // Warm the pool so the assembler's asset lookup hits (cold after reload).
            try {
              await ctx.assets.hydrate(new Set([source.assetId]));
            } catch {
              // IndexedDB unavailable — the assembler's own lookup falls back
            }
            const created = await createFrameFromAsset(ctx, {
              assetId: source.assetId,
              bounding: source.bounding,
              visibleShape: source.visibleShape.rect,
              displayName: `Pasted Image ${new Date().toLocaleTimeString()}`,
            });
            if (created) return;
          }
          if (blob) {
            const file = new File(
              [blob],
              `Pasted Image ${new Date().toLocaleTimeString()}.png`,
              { type: blob.type || 'image/png' }
            );
            await actions.adv.frame.create.trunk.execute({ source: file });
          } else if (sourceLayer?.type === 'image') {
            // An image layer was announced but its pixels cannot be resolved
            // and no PNG projection exists — degrade honestly.
            actions.setInteraction({
              hud: { message: 'New Frame failed — source data is unavailable', type: 'error' }
            });
          }
          return;
        }

        // ═══ Step 3B: Paste as a layer into the active frame ═══
        if (!activeFrame) return; // target 'layer' implies an open frame
        const targetGroupId = activeLayer?.type === 'group' ? activeLayer.id : activeLayer?.groupId;
        const insertIndex = ctx.layers.getInsertIndexAbove(activeFrame, activeLayer?.id);

        // Availability probe: same-frame references the pooled source directly
        // (no probing). Cross-frame requires EVERY asset the layer references —
        // its own pixels plus each bitmap mask's — to still resolve: `hydrate`
        // skips ids already in the pool and otherwise reloads the persisted
        // light record from IndexedDB, covering warm-pool and after-reload in
        // one call. An image layer that fails this is a DEGRADATION (8-bit
        // fallback + HUD notice); external payloads and non-image layers are not.
        let usable = isSameFrame;
        if (!usable && sourceLayer?.type === 'image') {
          const assetIds = LayerUtils.collectAssetIds([sourceLayer])[sourceLayer.id] ?? [];
          usable = assetIds.length > 0;
          for (const assetId of usable ? assetIds : []) {
            try {
              await ctx.assets.hydrate(new Set([assetId]));
            } catch {
              // IndexedDB unavailable — the get below answers from the pool alone
            }
            if (!ctx.assets.get(assetId)) {
              usable = false;
              break;
            }
          }
        }

        if (usable) {
          // ── Logical path: insert by reference, zero re-encode. The src and
          // assetId inherited from the clipboard render through the pool
          // (`assets.resolve`), so a stale objectURL never matters. ──
          const source = sourceLayer!;
          const {
            id: _id, locked: _locked, interactive: _inter, hostId: _hostId,
            ...layerWithoutId
          } = source;
              // Pose rule: identical canvas sizes share one
          // world coordinate system → keep the source pose verbatim (branch
          // frames match their parent's canvas — in-place paste). Different
          // sizes → re-derive the pose so the CONTENT center — cx is a pose
          // value, not a position: content world center = cx + O(rect.origin)
          // — lands on the target canvas center (world origin).
          const sameCanvas = !!sourceFrame
            && sourceFrame.canvas.w === activeFrame.canvas.w
            && sourceFrame.canvas.h === activeFrame.canvas.h;
          const centered = computeFragmentCenter(
            { x: 0, y: 0 },
            { x: source.visibleShape?.rect.x ?? 0, y: source.visibleShape?.rect.y ?? 0 },
            source.rotation ?? 0,
            source.flip ?? { h: false, v: false },
          );
          const pose = sameCanvas
            ? { cx: source.cx, cy: source.cy }
            : { cx: centered.x, cy: centered.y };
          const smartName = ctx.layers.getNewLayerName(
            activeFrame.layers.order.map(id => activeFrame.layers.byId[id]), `${source.name} Copy`
          );
          const newLayer = ctx.layers.getNewLayer({
            ...layerWithoutId,
            cx: pose.cx,
            cy: pose.cy,
            birthCenter: { cx: pose.cx, cy: pose.cy },
            groupId: targetGroupId,
            name: smartName,
          });
          ctx.layers.addLayer(activeFrame.id, newLayer, insertIndex);
        } else if (blob) {
          // ── Physical fallback: 8-bit blob re-ingest ──
          if (sourceLayer?.type === 'image') {
            actions.setInteraction({
              hud: { message: 'Pasted as 8-bit — original layer data is unavailable', type: 'info' }
            });
          }
          const newLayer = await ctx.layers.createLayerFromBlob(blob, activeFrame);
          if (targetGroupId) {
            newLayer.groupId = targetGroupId;
          }
          ctx.layers.addLayer(activeFrame.id, newLayer, insertIndex);
        } else if (sourceLayer?.type === 'image') {
          // Degraded payload with no blob at all — nothing to materialize.
          actions.setInteraction({
            hud: { message: 'Paste failed — source data is unavailable', type: 'error' }
          });
        }
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
      const { activeFrame, activeLayer, actions, geometry, layers } = ctx;
      if (!activeFrame) return;

      const box = getClipBox(activeFrame);
      if (!box) {
        actions.setInteraction({
          hud: { message: 'No active selection', type: 'error' }
        });
        return;
      }

      // Resolve target layer: explicit payload > activeLayer
      const targetLayerId = payload?.layerId ?? activeLayer?.id;
      if (!targetLayerId) {
        actions.setInteraction({
          hud: { message: 'No target layer', type: 'error' }
        });
        return;
      }
      const targetLayer = actions.fast?.latestLayer?.(activeFrame.id, targetLayerId) || activeFrame.layers.byId[targetLayerId];
      if (!targetLayer) {
        actions.setInteraction({
          hud: { message: 'Target layer not found', type: 'error' }
        });
        return;
      }
      if (targetLayer.locked) {
        actions.setInteraction({
          hud: { message: 'Layer is locked', type: 'error' }
        });
        return;
      }

      // Read feather radius from payload (0 = no feather)
      const feather = payload?.feather ?? 0;

      // ═══ Unified VectorMask path (regular + irregular) ═══
      // Project the selection to the target layer's local space *first* so the
      // mask geometry is expressed in the same coordinate system as the layer's
      // visibleShape. This fixes a latent misalignment for posed layers
      // (rotated/flipped/off-center): the previous regular-branch fed a
      // frame-local shape straight to applyMask, which only happened to align
      // for trunk layers (cx=cy=0, no rotation/flip). Mirrors the drill path.
      const layerPoly = geometry.polygon.frameLocalToLayerLocal(box, activeFrame, targetLayer);
      const localShape = polygonToShape(layerPoly);

      // Area guard (replaces the old `!maskAsset` guard from the bitmap path):
      // a degenerate selection (single click, collinear points) yields an
      // empty/near-zero path. Applying it would silently append an invalid mask
      // (layer vanishes or no-ops) with no user feedback. Early-out with the
      // same red pulse the removed bitmap branch used. Also covers the empty
      // degenerate-rect case the regular branch previously ignored.
      if (localShape.rect.w <= 0 || localShape.rect.h <= 0) {
        actions.setInteraction({
          hud: { message: 'Area is empty', type: 'error' }
        });
        return;
      }

      // polygonToShape recognizes 4-point rects / ellipse approximations as
      // rect/circle shapes, everything else as a path shape (absolute pathData,
      // multi-ring evenodd supported). All variants become a VectorMask via
      // applyMask → getNewVectorMask, appended to vectorMasks. No BitmapMask is
      // produced here anymore.
      layers.updateLayer(activeFrame.id, tx => {
        tx.edit(targetLayer.id).applyMask(localShape, { feather });
      });

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
      const { activeFrame, activeLayer, actions, geometry } = ctx;
      const isClipActive = ctx.state.interaction.interactionMode === 'clip';
      if (!activeFrame || !activeLayer || !isClipActive) return;

      try {
        const latestLayer = actions.fast?.latestLayer?.(activeFrame.id, activeLayer.id) || activeLayer;
        if (latestLayer.locked) {
          actions.setInteraction({
            hud: { message: 'Layer is locked', type: 'error' }
          });
          return;
        }

        const box = getClipBox(activeFrame);
        if (!box) {
          actions.setInteraction({
            hud: { message: 'No active selection', type: 'error' }
          });
          return;
        }

        const feather = payload?.feather ?? 0;

        // ═══ VectorMask path: add inverted VectorMask (no offscreen, no seam) ═══
        // Irregular (path) selections project through the polygon path so multi-ring
        // geometry survives; regular (rect/circle) selections project via shape space.
        const drillShape = polygonToShape(box);
        const localShape = drillShape.type === 'path'
          ? polygonToShape(geometry.polygon.frameLocalToLayerLocal(box, activeFrame, latestLayer))
          : geometry.shape.frameLocalToLayerLocal(drillShape, activeFrame, latestLayer);

        ctx.layers.updateLayer(activeFrame.id, tx => {
          tx.edit(latestLayer.id).applyMask(localShape, { inverted: true, feather });
        });

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
