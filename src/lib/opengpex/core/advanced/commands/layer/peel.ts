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

import { EditorContextValue, EditorCommand, asLocalShape } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { LayerFactory } from '@opengpex/editor/core/layer/factory';
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

        const { host, exchange, frags } = triplet;

        // ─── "Stamp" mode: exchange already has data → copy fragment ───
        // When CMD+Alt dragging an already-peeled fragment, leave a stamp (frag)
        // at the current exchange position and keep the exchange active for
        // continued dragging. The hole mask is PRESERVED — the host pixels were
        // already cut out during the initial peel and the stamp is a copy placed
        // at a potentially different location.
        if (triplet.state === 'dirty') {
          // ─── Create a temporary stamp (frag) layer at the current position ───
          // This ensures the stamp is visually left at the drag-start location instantly (0ms).
          // Both parentId and role ('frag') ensure it is treated as an internal sub-layer and hidden from the Layer List.
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
              // Session bookkeeping lives on the exchange only; a stamp is a
              // pure pixel clone and must not carry the hole pointer.
              metadata: undefined,
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

        // A non-copy peel EDITS the host (digs the hole vmask), so a locked
        // host must refuse it — same gate as the clip cut commands. Copy mode
        // only READS the host, so it stays available on locked layers
        // (Photoshop parity: Layer via Copy works where Layer via Cut is
        // disabled). No gate is needed at commit/discard time: this is the
        // only step that writes to the host outside rollback semantics.
        if (!payload.isCopy && latestLayer.locked) {
          actions.setInteraction({ hud: { message: 'Layer is locked', type: 'error' } });
          return;
        }

        // Resolve the clip shape from `frame.latestClipTool`. Peel fires via
        // Meta+drag on the unified createSelectionMoveHandler, so the active
        // frame-level selection entity is guaranteed non-empty at this point.
        // Supports both regular (LocalShape) and irregular (LocalPolygon) selections.
        const box = getClipBox(activeFrame);
        if (!box) return; // defensive — should never happen during a real peel
        const result = ctx.layers.fragmentToExistLayer(activeFrame, latestLayer, exchange, box);
        if (!result) return;

        const timestamp = Date.now();
        // The exact hole mask id for THIS session. The id template is a naming
        // convention only — removal must never pattern-match it, because once
        // a peel commits, its hole becomes a permanent user-facing mask and a
        // substring/tag sweep would destroy historical holes.
        const holeMaskId = `mask-peel-hole-${timestamp}`;

        // Start transaction: atomically update Exchange and Host
        ctx.layers.updateLayer(activeFrame.id, (tx) => {
          // A. Update Exchange (fragment). In copy mode there is no session
          // hole, so the pointer must stay unset — discardExchange removes a
          // hole BY THIS EXACT ID and nothing else. The fragment never
          // inherits the host's lock state: a locked exchange could not be
          // dragged, defeating the whole peel gesture (same rule as the
          // cut/duplicate flows).
          tx.edit(exchange.id).patch({
            ...result.updatedLayer,
            locked: false,
            metadata: payload.isCopy
              ? result.updatedLayer.metadata
              : {
                  ...(result.updatedLayer.metadata ?? {}),
                  activeHoleMaskId: holeMaskId,
                },
          });

          // B. If not in Copy mode, dig a hole in the Host
          if (!payload.isCopy) {
            const hostHoleMask = {
              id: holeMaskId,
              shape: result.localShape,
              inverted: true,
              feather: 0,
              enabled: true,
              tag: 'peel',
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

      const { host, exchange } = triplet;

      // Clean triplet → just re-activate host (no data to discard).
      if (triplet.state === 'clean') {
        if (activeLayer.id !== host.id) {
          layers.activate(activeFrame.id, host.id);
        }
        return;
      }

      // The hole dug by THIS session is tracked by its exact mask id on the
      // exchange (set by peelToExchange). Removal is exact-ID only: substring
      // or tag pattern sweeps would also destroy the PERMANENT holes left on
      // the host by previously committed peels. This write is restorative
      // (back to the pre-peel state), so it stays allowed even when the user
      // locked the host while the session was in flight.
      const holeMaskId = exchange.metadata?.activeHoleMaskId as string | undefined;

      // Dirty triplet → rollback: remove the session hole from the host,
      // reset the exchange. This restores the host to its pre-peel state
      // without any off-screen compositing.
      layers.updateLayer(activeFrame.id, (tx) => {
        if (holeMaskId) {
          tx.edit(host.id).patch({
            vectorMasks: (host.vectorMasks || []).filter(m => m.id !== holeMaskId),
          });
        }
        // reset() only writes the blank bitmap fields; the session hole
        // pointer must be cleared explicitly so it can never outlive the
        // session it belongs to.
        tx.edit(exchange.id).reset().patch({ metadata: undefined });
      });

      // Clean up temporary stamp layers
      if (triplet.frags.length > 0) {
        layers.removeLayers(activeFrame.id, triplet.frags.map(f => f.id));
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

        const { host, exchange, frags } = triplet;

        // [2] Admission check — when the triplet is clean (no peel happened
        // since last commit), short-circuit to avoid spending a Zustand
        // dispatch / reducer pipeline / re-render budget on a no-op. We only
        // re-activate the host when the active layer is *not* already the
        // host (e.g. a stale exchange focus from an aborted peel) — in the
        // common "user toggled clip mode without doing anything" path the
        // active layer is already host, so this whole branch becomes a few
        // hash lookups and returns immediately. Critical for keeping the
        // space-bar exit-clip latency imperceptible.
        if (triplet.state === 'clean') {
          if (activeLayer.id !== host.id) {
            layers.activate(activeFrame.id, host.id);
          }
          return;
        }

        try {
          // [3] Composite ONLY the peeled content: stamps (z-order bottom) →
          // exchange (top). The host is a pure bystander — its asset, pose,
          // grade chain and hole masks stay untouched. The hole is a
          // PERMANENT non-destructive vmask from here on: it shows up in the
          // mask list (toggle / delete / feather), and deleting it restores
          // the covered pixels (a natural "put the fragment back" flow).
          //
          // Participants carry their grade chains INTO the bake:
          // compositeLayers routes through SceneAssembler.buildScene, which
          // bakes every participant's adjustMasks into the composite pixels.
          // Re-attaching a chain to the product afterwards would apply the
          // grade a SECOND time, so the promoted layer ships with
          // adjustMasks: undefined — the same bake hygiene as
          // mergeDown/mergeVisible (bake content, strip declarative grade).
          // The appearance is frozen at merge time; further grading happens
          // through new masks on the promoted layer like on any layer.
          const participants = [...frags, exchange];

          const composited = await pixels.render.compositeLayers(participants, activeFrame);
          const { assetId, url: assetUrl } = await assets.storeBundle(composited);

          // Ensure bitmap is decoded into SourceBitmapCache BEFORE state update.
          // storeBundle() registers the asset (onRegistered hook warms both caches);
          // loadBitmap is cache-first so this is instant, no network.
          await pixels.image.loadBitmap(assetUrl);

          // The hole dug by THIS session, if any (absent in copy mode). The
          // exact mask id is the only sanctioned hole handle — never a
          // substring pattern.
          const sessionHoleMaskId = exchange.metadata?.activeHoleMaskId as string | undefined;

          // Single-fragment cut (no stamps, non-copy): wire the Merge Back
          // cut-link both ways — the product points at its hole, the hole
          // points at its product — so the existing mergeBack command and
          // the delete-fragment hole cleanup work with zero new machinery.
          const mergeBackHoleId = frags.length === 0 ? sessionHoleMaskId : undefined;

          // [4] Promote the baked composite to a REGULAR user-owned layer at
          // the exchange's slot (directly above the host). Deliberately not a
          // triplet role: it is user output, so it stays visible, selectable,
          // freely sortable and is NOT cascaded away with the host. The only
          // retained link is the sourceLayerId provenance stamp.
          const hostLayers = activeFrame.layers.order
            .map(id => activeFrame.layers.byId[id])
            .filter(l => !l.hostId);
          const newLayer = LayerFactory.getNewLayer({
            name: LayerFactory.getNewLayerName(hostLayers),
            src: assetUrl,
            assetId,
            cx: composited.bounds.x + composited.bounds.w / 2,
            cy: composited.bounds.y + composited.bounds.h / 2,
            bounding: { w: composited.bounds.w, h: composited.bounds.h },
            visibleShape: asLocalShape({ x: 0, y: 0, w: composited.bounds.w, h: composited.bounds.h }),
            scale: 1,
            rotation: 0,
            flip: { h: false, v: false },
            // The pipeline baked every participant's grade chain into these
            // pixels; carrying a chain forward would grade twice.
            adjustMasks: undefined,
            metadata: {
              sourceLayerId: host.id,
              ...(mergeBackHoleId ? { assocMaskId: mergeBackHoleId } : {}),
            },
          });

          const exchangeIndex = activeFrame.layers.order.indexOf(exchange.id);
          layers.addLayer(activeFrame.id, newLayer, exchangeIndex !== -1 ? exchangeIndex : undefined);

          layers.updateLayer(activeFrame.id, (tx) => {
            // Reset the session helpers. metadata must be cleared explicitly:
            // reset() only writes the blank bitmap fields, which would leave
            // the stale session hole pointer behind.
            tx.edit(exchange.id).reset().patch({ metadata: undefined });

            if (mergeBackHoleId) {
              tx.edit(host.id).patch({
                vectorMasks: (host.vectorMasks || []).map(m =>
                  m.id === mergeBackHoleId ? { ...m, assocLayerId: newLayer.id } : m,
                ),
              });
            }
          });

          // Clean up temporary stamp layers
          if (frags.length > 0) {
            layers.removeLayers(activeFrame.id, frags.map(f => f.id));
          }

          // PS "Layer via Cut" intuition: focus lands on the new fragment.
          layers.activate(activeFrame.id, newLayer.id);

        } catch (err) {
          console.error('[Commit] Failed to commit composite layers:', err);
          actions.setInteraction({ hud: { message: 'Merge failed.', type: 'error' } });
        }
      });
    }
  } as EditorCommand<void, Promise<void>>
};
