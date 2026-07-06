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

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import * as P from '@opengpex/editor/core/advanced/protocols';


/**
 * PEEL_COMMANDS: Fragment peeling command set.
 * Used for real-time layer fragment extraction and exchange in high-frequency interactions.
 */
export const LayerPeelCommands = {
  peelToExchange: {
    id: P.ADV_LAYER_PEEL_EXCHANGE,
    name: 'Peel to Exchange',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload: { isCopy: boolean }): Promise<void> => {
      const { activeFrame, activeLayer, actions, layers } = ctx;
      if (!activeFrame || !activeLayer || activeLayer.type !== 'image') return;

      try {
        // ─── Resolve the triplet regardless of whether activeLayer is host or exchange ───
        const triplet = layers.getTriplet(activeFrame.id, activeLayer.id);
        if (!triplet) return;

        const { host, exchange } = triplet.group;

        // ─── "Stamp" mode: exchange already has data → optimistic update ───
        // Photoshop-style instant feedback: synchronously remove the hole mask
        // so the host appears whole again. The exchange layer stays in place and
        // the rendering pipeline naturally composites host + exchange — giving
        // the same visual as a baked merge, but with zero async overhead.
        // The real pixel merge is deferred to commit (Space/Enter via mergeExchange).
        if (triplet.dirty) {
          const currentMasks = host.vectorMasks || [];
          const newMasks = currentMasks.filter(m => !m.id.includes('mask-peel-hole'));

          // Fast-track override: ensures the painter sees the mask removal
          // immediately during the active drag interaction. Without this, the
          // painter reads from the stale stateRef (not the Zustand store) while
          // the interaction's volatile state is active, making the store-only
          // update invisible until after drag ends.
          actions.fast.override(activeFrame.id, host.id, { vectorMasks: newMasks });

          // Also update the store for non-rendering consumers (getTriplet reads,
          // mergeExchange at commit time, undo snapshots, etc.).
          layers.updateLayer(activeFrame.id, (tx) => {
            tx.edit(host.id).removeMask('mask-peel-hole');
          });

          // ─── Create a temporary stamp (frag) layer at the current position ───
          // This ensures the stamp is visually left at the drag-start location instantly (0ms).
          // Both parentId and role ('frag') ensure it is treated as an internal sub-layer and hidden from the Layer List.
          const frags = activeFrame.layers.order
            .map(id => activeFrame.layers.byId[id])
            .filter(l => l.hostId === host.id && l.role === 'frag');

          const isDuplicate = frags.some(f =>
            Math.abs(f.cx - exchange.cx) < 1 && Math.abs(f.cy - exchange.cy) < 1
          );

          if (!isDuplicate) {
            const stampId = `stamp_${host.id}_${Date.now()}`;
            const stampLayer = {
              ...exchange,
              id: stampId,
              role: 'frag' as const,
              hostId: host.id,
              interactive: false,
            };

            const hostIndex = activeFrame.layers.order.indexOf(host.id);
            const exchangeIndex = activeFrame.layers.order.indexOf(exchange.id);
            const insertIndex = exchangeIndex !== -1 ? exchangeIndex : hostIndex + 1;
            layers.addLayer(activeFrame.id, stampLayer, insertIndex);
          }

          // Restore focus to exchange layer to keep dragging it
          layers.activate(activeFrame.id, exchange.id);

          return;
        }

        // ─── First peel: exchange is empty → standard peel from host ───
        const latestLayer = actions.fast.latestLayer(activeFrame.id, host.id) || host;

        // Resolve the clip shape from `frame.latestClipTool`. Peel only
        // fires via Meta+drag on the clip box (createClipBoxHandler), so the
        // active tool's slot in clipBoxes is guaranteed non-empty at this point.
        const box = getClipBox(activeFrame);
        const clipShape = box?.regular ? box.spatial : null;
        if (!clipShape) return; // defensive — should never happen during a real peel
        const result = ctx.layers.fragmentToExistLayer(activeFrame, latestLayer, exchange, clipShape);
        if (!result) return;

        const timestamp = Date.now();

        // Start transaction: atomically update Exchange and Host
        ctx.layers.updateLayer(activeFrame.id, (tx) => {
          // A. Update Exchange (fragment)
          tx.edit(exchange.id).patch(result.updatedLayer);

          // B. If not in Copy mode, dig a hole in the Host
          if (!payload.isCopy) {
            const hostHoleMask = {
              id: `mask-peel-hole-${timestamp}`,
              shape: result.localShape,
              inverted: true,
              feather: 0,
              enabled: true
            };
            const currentMasks = latestLayer.vectorMasks || [];
            tx.edit(host.id).patch({
              vectorMasks: [...currentMasks, hostHoleMask]
            });
          }
        });

        // Switch focus to the fragment, taking over subsequent drag operations
        ctx.layers.activate(activeFrame.id, exchange.id);

      } catch (err) {
        console.error('[ClipCommands] Peel to exchange failed:', err);
      }
    }
  } as EditorCommand<{ isCopy: boolean }, Promise<void>>,

  discardExchange: {
    id: P.ADV_LAYER_PEEL_DISCARD,
    name: 'Discard Peel (Cancel)',
    undoable: false,
    execute: (ctx: EditorContextValue): void => {
      const { activeFrame, activeLayer, layers } = ctx;
      if (!activeFrame || !activeLayer) return;

      const triplet = layers.getTriplet(activeFrame.id, activeLayer.id);
      if (!triplet) return;

      const { host, exchange, frag } = triplet.group;

      // Clean triplet → just re-activate host (no data to discard).
      if (!triplet.dirty) {
        if (activeLayer.id !== host.id) {
          layers.activate(activeFrame.id, host.id);
        }
        return;
      }

      // Find any temporary stamp layers
      const frags = activeFrame.layers.order
        .map(id => activeFrame.layers.byId[id])
        .filter(l => l.hostId === host.id && l.role === 'frag');

      // Dirty triplet → rollback: remove the hole mask from host, reset
      // exchange (and frag if present). This restores the host to its
      // pre-peel state without any off-screen compositing.
      layers.updateLayer(activeFrame.id, (tx) => {
        tx.edit(host.id).removeMask('mask-peel-hole');
        tx.edit(exchange.id).reset();
        if (frag) {
          tx.edit(frag.id).reset();
        }
      });

      // Clean up temporary stamp layers
      if (frags.length > 0) {
        layers.removeLayers(activeFrame.id, frags.map(f => f.id));
      }

      layers.activate(activeFrame.id, host.id);
    }
  } as EditorCommand<void, void>,

  mergeExchange: {
    id: P.ADV_LAYER_MERGE_HOST,
    name: 'Commit Composite Layers',
    undoable: false,
    execute: (ctx: EditorContextValue): Promise<void> => {
      const { assets } = ctx;
      return assets.withSession(async () => {
        const { activeFrame, activeLayer, actions, pixels, layers } = ctx;
        if (!activeFrame || !activeLayer) return;

        // [1] Get the triplet structure
        const triplet = layers.getTriplet(activeFrame.id, activeLayer.id);
        if (!triplet) return;

        const { host, exchange, frag } = triplet.group;

        // [2] Admission check — when the triplet is clean (no peel happened
        // since last commit), short-circuit to avoid spending a Zustand
        // dispatch / reducer pipeline / re-render budget on a no-op. We only
        // re-activate the host when the active layer is *not* already the
        // host (e.g. a stale exchange focus from an aborted peel) — in the
        // common "user toggled clip mode without doing anything" path the
        // active layer is already host, so this whole branch becomes a few
        // hash lookups and returns immediately. Critical for keeping the
        // space-bar exit-clip latency imperceptible (see clip tool guide §4.2).
        if (!triplet.dirty) {
          if (activeLayer.id !== host.id) {
            layers.activate(activeFrame.id, host.id);
          }
          return;
        }

        // Find all temporary stamp layers
        const frags = activeFrame.layers.order
          .map(id => activeFrame.layers.byId[id])
          .filter(l => l.hostId === host.id && l.role === 'frag');

        try {
          // [3] Call PixelService to execute off-screen compositing.
          // Merges host (base), all stamped frags, and the final exchange layer in sequence.
          const mergeItems = [
            ...frags.map(f => ({ layer: f, relative: true })),
            { layer: exchange, relative: true }
          ];

          const assetResult = await pixels.worker.asAsset(
            pixels.worker.mergeLayersToLayer(host, mergeItems)
          );
          if (!assetResult) throw new Error('Asset registration failed');

          // [4] Force pre-decoding
          try {
            await pixels.decode.htmlImage(assetResult.url);
          } catch (e) {
            console.warn('[Commit] Preload failed:', e);
          }

          // [5] Start transaction update (commit all changes atomically)
          layers.updateLayer(activeFrame.id, (tx) => {
            // Update host: set asset + clean up hole masks
            tx.edit(host.id)
              .setAsset(assetResult)
              .removeMask('mask-peel-hole');

            // Reset helper layers
            tx.edit(exchange.id).reset();
            if (frag) {
              tx.edit(frag.id).reset();
            }
          });

          // Clean up temporary stamp layers
          if (frags.length > 0) {
            layers.removeLayers(activeFrame.id, frags.map(f => f.id));
          }

          layers.activate(activeFrame.id, host.id);

        } catch (err) {
          console.error('[Commit] Failed to commit composite layers:', err);
          actions.setInteraction({ hud: { message: 'Merge failed.', type: 'error' } });
        }
      });
    }
  } as EditorCommand<void, Promise<void>>
};
