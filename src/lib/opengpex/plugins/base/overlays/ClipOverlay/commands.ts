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
 * peel/commands.ts — the fragment peeling command family. Lives in the
 * ClipOverlay plugin: these commands are the state-machine half of an
 * interaction protocol (they read the live selection, the focus, and the
 * in-flight gesture registration — see ./session.ts and ./inflight.ts),
 * not parameter-driven document services reusable by arbitrary callers.
 * Core only carries the protocol id strings; dispatch is by id through the
 * central executeCommand registry.
 */

import { EditorContextValue, EditorCommand, asLocalShape, asWorldRect, type Frame, type Layer, type LocalShape, type TransformParams, type FragmentPose } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { LayerFactory } from '@opengpex/editor/core/layer/factory';
import {
  CMD_PEEL_EXCHANGE,
  CMD_PEEL_MERGE,
  CMD_PEEL_DISCARD,
  CMD_PEEL_SETTLE,
  CMD_PEEL_RESET_TRANSFORM,
  CMD_PEEL_APPLY_TRANSFORM,
} from './protocols';
import {
  readPeelSession,
  writePeelSession,
  type PeelSession,
} from './peel/session';
import {
  consumeInflightFragmentTransform,
} from './peel/inflight';

/**
 * Module-level settle lock (the command-layer mutex). The store is a React
 * reducer whose visible state (`stateRef.current`) only refreshes after a
 * render — a write dispatched mid-command is invisible to readers on the
 * same stack and for the whole async window that follows. While a commit is
 * in flight, a concurrently arriving settle (Esc, unmount fallback, …) would
 * read the stale pre-commit session and could roll a COMPLETED peel back,
 * destroying a permanent hole. The lock makes such calls VOID (not queued —
 * during committing, Esc means "nothing to do"). It lives outside the render
 * tree and outside persistence on purpose: it guards a single call-stack
 * adjudication, not a document fact.
 */
let peelSettleInFlight = false;

/** Test isolation only: forces the settle lock open between tests. */
export function resetPeelSettleLockForTests(): void {
  peelSettleInFlight = false;
}

/** Resolves on the next animation frame (immediately where none exists, e.g. headless tests). */
function nextAnimationFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

/**
 * Waits until the COMMITTED store (not the fast-track merge) shows the layer
 * on the given asset — i.e. React has rendered the bake write. Reads through
 * `fast.latestFrame`, whose layer table is the committed one (frame drafts
 * never carry layers). Bounded so a dropped dispatch can never hang a
 * gesture teardown; on timeout the caller proceeds exactly as before.
 */
async function awaitCommittedLayerAsset(
  ctx: EditorContextValue,
  frameId: string,
  layerId: string,
  assetId: string,
): Promise<void> {
  const MAX_FRAMES = 60;
  for (let i = 0; i < MAX_FRAMES; i++) {
    const committed = ctx.actions.fast.latestFrame(frameId)?.layers.byId[layerId];
    if (!committed || committed.assetId === assetId) return;
    if (typeof requestAnimationFrame !== 'function') return;
    await nextAnimationFrame();
  }
}

/**
 * Resolves the session's participants straight from the record (NEVER from
 * the active layer — focus may legitimately sit elsewhere mid-session), and
 * validates them against live layer state. A record whose host or exchange
 * died before it did (layer deleted mid-session, undo across the session
 * boundary, frame copy that regenerated layer ids) is silently cleared so
 * no consumer ever writes through a dangling reference.
 *
 * Returns null (after clearing a dangling record) when the session cannot
 * be trusted; the caller must then behave exactly as if no session existed.
 */
function resolveSessionParticipants(
  ctx: EditorContextValue,
  frame: Frame,
  session: PeelSession
): { host: Layer; exchange: Layer; frags: Layer[] } | null {
  const host = frame.layers.byId[session.hostId];
  const exchange = frame.layers.byId[session.exchangeId];
  if (!host || !exchange || exchange.hostId !== session.hostId) {
    ctx.actions.updateFrame(frame.id, writePeelSession(frame, null));
    return null;
  }
  const frags = frame.layers.order
    .map(id => frame.layers.byId[id])
    .filter(l => l && l.hostId === session.hostId && l.role === 'frag');
  return { host, exchange, frags };
}

/**
 * PEEL_COMMANDS: Fragment peeling command set.
 * Used for real-time layer fragment extraction and exchange in high-frequency interactions.
 *
 * Lifecycle model (2026-11 state machine): the session lives in
 * `frame.drafts['peel']` (see ./session.ts). The three commands below are
 * pure state transitions over that record — none of them sniffs exchange
 * pixels to guess where the session stands:
 *
 *   peelToExchange   absent → creates record ('peeled'); 'peeled' → stamp;
 *                    'committing' → no-op (defensive).
 *   mergeExchange    'peeled' → adjudicates ('committing') then promotes and
 *                    DELETES the record; absent/'committing' → idempotent exit.
 *   discardExchange  'peeled' → rolls back and DELETES the record; anything
 *                    else → idempotent exit WITHOUT touching focus.
 *   settle           the single convergence API for every exit path; owns
 *                    the in-flight lock.
 */
export const PEEL_COMMANDS = {
  peelToExchange: {
    id: CMD_PEEL_EXCHANGE,
    name: 'Peel to Exchange',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload: { isCopy: boolean }): Promise<void> => {
      const { activeFrame, activeLayer, actions, layers } = ctx;
      if (!activeFrame || !activeLayer || activeLayer.type !== 'image') return;

      try {
        // ─── Session-first branching: the record decides, pixels follow ───
        const session = readPeelSession(activeFrame);
        if (session?.status === 'committing') return; // a commit is adjudicated — nothing to stamp or peel

        // ─── Resolve the triplet regardless of whether activeLayer is host or exchange ───
        const triplet = layers.getTriplet(activeFrame.id, activeLayer.id);
        if (!triplet) return;

        const { host, exchange, frags } = triplet;

        // ─── "Stamp" mode: session undecided → copy fragment ───
        // When CMD+Alt (or CMD) dragging an already-peeled fragment, leave a
        // stamp (frag) at the current exchange position and keep the exchange
        // active for continued dragging. The hole mask is PRESERVED — the
        // host pixels were already cut out during the initial peel and the
        // stamp is a copy placed at a potentially different location.
        if (session?.status === 'peeled' && resolveSessionParticipants(ctx, activeFrame, session)) {
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
        // A dangling record was cleared inside resolveSessionParticipants —
        // fall through and run a fresh first peel instead of stamping
        // through dead ids.

        // ─── First peel: no session record → standard peel from host ───
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
        const result = ctx.layers.clipToExistLayer(activeFrame, latestLayer, exchange, box);
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

        // Declare the session. From here the lifecycle is explicit: commit
        // and discard both key off THIS record, not off pixel content. The
        // write rides the same undoable command execution as the hole dig,
        // so one undo step restores pixels and session together.
        const freshFrame = ctx.actions.fast.latestFrame(activeFrame.id) ?? activeFrame;
        const peeled = { ...exchange, ...result.updatedLayer };
        ctx.actions.updateFrame(activeFrame.id, writePeelSession(freshFrame, {
          hostId: host.id,
          exchangeId: exchange.id,
          holeMaskId: payload.isCopy ? null : holeMaskId,
          status: 'peeled',
          // The reset-size reference: the fragment as cut (source asset +
          // crop) and the selection it was cut with.
          origin: {
            layer: {
              assetId: peeled.assetId,
              src: peeled.src,
              cx: peeled.cx,
              cy: peeled.cy,
              rotation: peeled.rotation,
              flip: { ...peeled.flip },
              bounding: { ...peeled.bounding },
              visibleShape: peeled.visibleShape,
              adjustMasks: peeled.adjustMasks,
            },
            confinement: box,
          },
          accRotation: 0,
        }));

        // Switch focus to the fragment, taking over subsequent drag operations
        ctx.layers.activate(activeFrame.id, exchange.id);

      } catch (err) {
        console.error('[ClipCommands] Peel to exchange failed:', err);
      }
    }
  } as EditorCommand<{ isCopy: boolean }, Promise<void>>,

  discardExchange: {
    id: CMD_PEEL_DISCARD,
    name: 'Discard Peel (Cancel)',
    undoable: false,
    execute: (ctx: EditorContextValue): void => {
      const { activeFrame, layers } = ctx;
      if (!activeFrame) return;

      // Session gate: absent or non-'peeled' → nothing to discard. Note the
      // deliberate absence of a focus write here — an idempotent re-entry
      // (e.g. the unmount fallback after a successful commit) must NOT yank
      // focus away from the layer the commit just promoted.
      const session = readPeelSession(activeFrame);
      if (!session || session.status !== 'peeled') return;

      // The hole dug by THIS session is tracked by its exact mask id on the
      // session record. Removal is exact-ID only: substring or tag pattern
      // sweeps would also destroy the PERMANENT holes left on the host by
      // previously committed peels. This write is restorative (back to the
      // pre-peel state), so it stays allowed even when the user locked the
      // host while the session was in flight.
      const resolved = resolveSessionParticipants(ctx, activeFrame, session);
      if (!resolved) return;
      const { host, exchange, frags } = resolved;

      // Self-ledgered bracket (defense in depth). The ledger now keeps an
      // open checkpoint after every undo, so these writes would never throw
      // — but left unbracketed they fold into whatever unrelated boundary
      // closes next, replaying the whole abandoned session as a stray edit
      // mixed into someone else's undo step. Opening and closing a boundary
      // here keeps the rollback as one isolated, reviewable step.
      ctx.actions.history.commitCheckpoint(activeFrame.id);

      // Rollback: remove the session hole from the host, reset the exchange.
      // This restores the host to its pre-peel state without any off-screen
      // compositing.
      layers.updateLayer(activeFrame.id, (tx) => {
        if (session.holeMaskId) {
          tx.edit(host.id).patch({
            vectorMasks: (host.vectorMasks || []).filter(m => m.id !== session.holeMaskId),
          });
        }
        // reset() only writes the blank bitmap fields; the session hole
        // pointer must be cleared explicitly so it can never outlive the
        // session it belongs to.
        tx.edit(exchange.id).reset().patch({ metadata: undefined });
      });

      // The selection travelled and deformed with the fragment during the
      // session; cancelling the peel puts it back where the peel cut it, so
      // an immediate re-peel takes the original region. Records written
      // before the peel-time snapshot existed keep the selection as is.
      if (session.origin?.confinement) {
        ctx.actions.updateFrame(activeFrame.id, { confinement: session.origin.confinement });
      }

      // Clean up temporary stamp layers
      if (frags.length > 0) {
        layers.removeLayers(activeFrame.id, frags.map(f => f.id));
      }

      // Settle = the record is gone. Absence IS the terminal state.
      const freshFrame = ctx.actions.fast.latestFrame(activeFrame.id) ?? activeFrame;
      ctx.actions.updateFrame(activeFrame.id, writePeelSession(freshFrame, null));

      // Focus returns to the host — the layer the user was working on before
      // the peel. (This is the one path that owns this write.)
      layers.activate(activeFrame.id, host.id);

      // Close the bracket opened above: the rollback is now one isolated
      // undo step regardless of which boundary fires next.
      ctx.actions.history.commitCheckpoint(activeFrame.id);
    }
  } as EditorCommand<void, void>,

  mergeExchange: {
    id: CMD_PEEL_MERGE,
    name: 'Commit Composite Layers',
    undoable: false,
    execute: (ctx: EditorContextValue): Promise<boolean> => {
      const { assets } = ctx;
      return assets.withSession(async (): Promise<boolean> => {
        const { activeFrame, activeLayer, actions, layers } = ctx;
        if (!activeFrame) return false;

        // ─── Session gate ───
        // Absent or non-'peeled' → idempotent exit (the old clean-triplet
        // fast path, now driven by the record instead of a pixel sniff).
        // The only surviving duty of this branch is re-focusing the host
        // when a stale exchange focus was left behind by an aborted peel;
        // in the common "nothing happened" path this is a few hash lookups.
        const session = readPeelSession(activeFrame);
        if (!session || session.status !== 'peeled') {
          if (activeLayer) {
            const triplet = layers.getTriplet(activeFrame.id, activeLayer.id);
            if (triplet && activeLayer.id !== triplet.host.id) {
              layers.activate(activeFrame.id, triplet.host.id);
            }
          }
          return false;
        }

        // Dangling record → clear it and exit; never write through dead ids.
        const resolved = resolveSessionParticipants(ctx, activeFrame, session);
        if (!resolved) return false;
        const { host, exchange, frags } = resolved;

        // ─── Adjudication write ───
        // Flip the session to 'committing' SYNCHRONOUSLY, before any await.
        // This is the verdict that wins the race: every settle call from
        // here until the record is deleted is void (the settle lock covers
        // the visibility gap until the write flushes into view).
        //
        // No history boundary of its own: this write must stay INSIDE the
        // diff window the caller (settleExchange) opened before invoking
        // this command. An internal SIGNAL_COMMIT here would record the
        // 'peeled' → 'committing' intermediate as its own undo step, and
        // undoing the commit would walk back through a state no UI can
        // render (status 'committing' shows no confirm/cancel affordances).
        // The caller's bracket spans the whole async bake window, so every
        // write below lands inside one step by construction; this command
        // has no other invocation site than settleExchange.
        const freshFrameForAdjudication = actions.fast.latestFrame(activeFrame.id) ?? activeFrame;
        actions.updateFrame(activeFrame.id, writePeelSession(freshFrameForAdjudication, {
          ...session,
          status: 'committing',
        }));

        try {
          // ─── Composite ONLY the peeled content: stamps (z-order bottom) →
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

          const { composited, assetId, url: assetUrl } = await ctx.layers.bakeToAsset(activeFrame, participants);

          // Outline rebuild — ALWAYS traced, unconditionally (supersedes the
          // earlier per-tool gate): a rotated host turns even a rect-tool cut
          // into a tilted contour inside the composite AABB, and an
          // ellipse/lasso contour never equals its bounding box, so no tool
          // can safely skip the trace. A fully-opaque product (unrotated
          // rect cut) short-circuits inside traceAlphaRings to the exact
          // full-bounds ring — equivalent to the rect, so tracing is correct
          // in every case. Failure-safe: null falls back to the full-bounds
          // rect and never blocks the landing.
          const outlinePath = await ctx.layers.traceAlphaOutline(composited);

          // The hole dug by THIS session, if any (null in copy mode). The
          // exact mask id is the only sanctioned hole handle — never a
          // substring pattern.
          const sessionHoleMaskId = session.holeMaskId;

          // Single-fragment cut (no stamps, non-copy): wire the Merge Back
          // cut-link both ways — the product points at its hole, the hole
          // points at its product — so the existing mergeBack command and
          // the delete-fragment hole cleanup work with zero new machinery.
          const mergeBackHoleId = frags.length === 0 ? (sessionHoleMaskId ?? undefined) : undefined;

          // ─── Promote the baked composite to a REGULAR user-owned layer at
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
            // Product-record conventions from the shared bake primitive
            // (services/baking.ts): pose reset, full-bounds rect crop release
            // (or the traced alpha contour for irregular selections), grade
            // chain stripped. Declaration inlined: the metadata object is
            // freshly composed here — nothing to merge. `clipTool` lets the
            // LayersDrawer Refocus re-arm the tool the fragment was cut with.
            ...ctx.layers.bakedLayerPatch(composited.bounds, { outlinePath: outlinePath ?? undefined }),
            metadata: {
              physicalPixels: true,
              clipTool: activeFrame.latestClipTool,
              sourceLayerId: host.id,
              ...(mergeBackHoleId ? { assocMaskId: mergeBackHoleId } : {}),
            },
          });

          const exchangeIndex = activeFrame.layers.order.indexOf(exchange.id);
          layers.addLayer(activeFrame.id, newLayer, exchangeIndex !== -1 ? exchangeIndex : undefined);

          layers.updateLayer(activeFrame.id, (tx) => {
            // Reset the session helpers. metadata must be cleared explicitly:
            // reset() only writes the blank bitmap fields, which would leave
            // the stale session hole pointer behind. This is capacity
            // hygiene only — the session's semantic endpoint is the record
            // deletion below, not this reset.
            tx.edit(exchange.id).reset().patch({ metadata: undefined });

            if (mergeBackHoleId) {
              const latestHost = actions.fast.latestLayer(activeFrame.id, host.id) ?? host;
              tx.edit(host.id).patch({
                vectorMasks: (latestHost.vectorMasks || []).map(m =>
                  m.id === mergeBackHoleId ? { ...m, assocLayerId: newLayer.id } : m,
                ),
              });
            }
          });

          // Settle = the record is gone, in the same synchronous batch as
          // the promotion writes. From the next flush onward every settle
          // caller sees "no session" and short-circuits.
          const freshFrame = actions.fast.latestFrame(activeFrame.id) ?? activeFrame;
          actions.updateFrame(activeFrame.id, writePeelSession(freshFrame, null));

          // Clean up temporary stamp layers
          if (frags.length > 0) {
            layers.removeLayers(activeFrame.id, frags.map(f => f.id));
          }

          // PS "Layer via Cut" intuition: focus lands on the new fragment.
          layers.activate(activeFrame.id, newLayer.id);
          return true;

        } catch (err) {
          console.error('[Commit] Failed to commit composite layers:', err);
          actions.setInteraction({ hud: { message: 'Merge failed.', type: 'error' } });
          // Release the adjudication: the session returns to 'peeled' so the
          // user can retry the commit (or discard) instead of the record
          // bricking in a state every settle call refuses to touch.
          const freshFrame = actions.fast.latestFrame(activeFrame.id) ?? activeFrame;
          actions.updateFrame(activeFrame.id, writePeelSession(freshFrame, {
            ...session,
            status: 'peeled',
          }));
          return false;
        }
      });
    }
  } as EditorCommand<void, Promise<boolean>>,

  /**
   * applyTransform — the WRITE-COPY bake of a fragment transform gesture
   * (Phase 3): renders the exchange at its final gesture pose (scale ×
   * rotation) into a NEW asset, then swaps the exchange onto that asset with
   * the pose reset. One undoable step.
   *
   * Why the GPU composite route: the bake MUST reproduce the exact pixels
   * the live preview showed (acceptance: committed pixels match the preview)
   * and must preserve high-depth sources. Both fall out of reusing
   * `compositeLayers` — the SAME machine the peel commit uses, which
   * assembles through SceneAssembler and samples the FULL-RESOLUTION shared
   * source texture (the visibleShape crop is a per-node UV window, not a
   * cropped cache). The gesture magnification rides the explicit
   * `poseOverrides` seam — the same channel the live preview used — so bake
   * pixels ≡ preview pixels by construction.
   *
   * Write-copy safety: the exchange SHARES the host's assetId (and stamps
   * clone it). Nothing here ever writes through that id — `storeBundle`
   * registers a fresh content-addressed asset and only the EXCHANGE's layer
   * record is patched. The host (and its hole) are bystanders: the hole is
   * an inverted vmask on the host, fully decoupled from where the fragment
   * flies or how it is rotated.
   */
  applyTransform: {
    id: CMD_PEEL_APPLY_TRANSFORM,
    name: 'Bake Fragment Transform',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload: { pose: TransformParams }): Promise<void> => {
      const { activeFrame, geometry } = ctx;
      if (!activeFrame) return;

      // Session gate: transforms are pose edits WITHIN a peeled session.
      const session = readPeelSession(activeFrame);
      if (!session || session.status !== 'peeled') return;
      const resolved = resolveSessionParticipants(ctx, activeFrame, session);
      if (!resolved) return;
      const { exchange } = resolved;
      if (exchange.type !== 'image') return;

      const pose = payload?.pose;
      if (!pose) return;
      const scale = pose.scale ?? 1;
      const scaleY = pose.scaleY ?? scale;
      const rotation = pose.rotation ?? exchange.rotation;
      const cx = pose.cx ?? exchange.cx;
      const cy = pose.cy ?? exchange.cy;
      // LOCAL-frame right rotation (selection-driven scale): the composite
      // linear part becomes O(θ)·S·R(−θ) — the factors stretch along the
      // solved frame's axes. Absent (= 0) for rotation gestures and every
      // other consumer; the world matrix is bitwise unchanged then.
      const sourceAngle = pose.sourceAngle ?? 0;

      // Identity no-op: a static click on a handle must not spend a resample
      // or an undo step re-baking identical pixels.
      const identity =
        scale === 1 && scaleY === 1 &&
        rotation === exchange.rotation && cx === exchange.cx && cy === exchange.cy &&
        sourceAngle === 0;
      if (identity) return;

      // Content-box geometry at the FINAL pose. The content box (the
      // visibleShape crop) is what the user transformed; its pose params
      // also drive the selection follow below.
      const vs = exchange.visibleShape?.rect ?? {
        x: 0, y: 0, w: exchange.bounding.w, h: exchange.bounding.h,
      };
      const params: FragmentPose = {
        cx,
        cy,
        rotation,
        flip: exchange.flip,
        bounding: { w: vs.w, h: vs.h },
        visibleOffset: { x: vs.x, y: vs.y },
        scale,
        scaleY,
        sourceAngle,
      };

      // ── Bake ROI from the SELECTION, not the fragment ──
      // The selection is the session's reference entity: the gesture's
      // followFragmentSelection output IS the fragment's content shape at
      // the final pose, expressed in frame-local coordinates — pristine
      // geometry that carries no history. Its AABB (+1px AA margin) is
      // therefore the honest bake ROI. Deriving the ROI from the
      // fragment's own content box instead would inherit every earlier
      // bake's padding: a rotated bake's output is the rotated AABB with
      // empty corners, those corners become "content", and rotating back
      // to upright would keep the inflated box forever (the visibleShape
      // larger than the real fragment). Rotating away and back under the
      // selection-derived ROI lands exactly on the original size.
      const startParams = geometry.transform.fragmentPoseFromLayer(exchange);
      const nextConfinement = activeFrame.confinement
        ? geometry.transform.followFragmentSelection(activeFrame.confinement, startParams, params, activeFrame)
        : null;
      const AA_MARGIN_PX = 1;
      const roiLocal: LocalShape = nextConfinement && nextConfinement.rect.w > 0 && nextConfinement.rect.h > 0
        ? asLocalShape({
            x: nextConfinement.rect.x - AA_MARGIN_PX,
            y: nextConfinement.rect.y - AA_MARGIN_PX,
            w: nextConfinement.rect.w + 2 * AA_MARGIN_PX,
            h: nextConfinement.rect.h + 2 * AA_MARGIN_PX,
          })
        // No selection (degenerate session): fall back to the pose-derived
        // content-box ROI so the bake never loses its reference.
        : asLocalShape(geometry.space.worldToLocalRect(asWorldRect(geometry.transform.fragmentBakeRoi(params, 1)), activeFrame));

      // ── Bake ROI budget gate ──
      // The composite below renders the ROI through a GPU staging buffer for
      // readback (width × height × 8 bytes on the RGBA16Float pipeline). Past
      // a certain footprint the driver refuses the allocation and the failure
      // used to cascade (invalid buffer → uncaught rejection escaping the
      // gesture). A pre-composite gate turns that cliff into an explicit,
      // retryable refusal: the session never left 'peeled', so the gesture
      // can end normally and the user may retry a smaller pose. It does NOT
      // bound total memory use — repeated bakes still accumulate undo-ledger
      // assets — it only refuses the single oversized bake.
      const MAX_BAKE_ROI_TEXELS = 96_000_000;
      if (roiLocal.rect.w * roiLocal.rect.h > MAX_BAKE_ROI_TEXELS) {
        ctx.actions.setInteraction({ hud: { message: 'Fragment is too large to bake — reduce its size first.', type: 'error' } });
        return;
      }

      // Render the fragment at its final pose from the full-resolution
      // source. The posed clone carries the new cx/cy/rotation as regular
      // layer fields; the scale rides `poseOverrides` (no Layer field).
      // Every allocation-heavy stage below (composite, asset bundle, bitmap
      // decode) can fail on resource exhaustion; the catch mirrors the
      // mergeExchange discipline — HUD feedback, session back to 'peeled'
      // (retryable), no escape into the gesture teardown.
      const posed: Layer = { ...exchange, cx, cy, rotation };
      try {
        const { composited, assetId: newAssetId, url: newUrl } = await ctx.layers.bakeToAsset(
          activeFrame,
          [posed],
          { roi: roiLocal, poseOverrides: { [exchange.id]: { scale, scaleY, sourceAngle } } },
        );

        // Always rebuild the outline from the baked alpha: the previous bake
        // (if any) already released the crop to a full rect, so tracing is the
        // only way this product keeps a true-contour record. Failure-safe —
        // null keeps the full-bounds rect.
        const outlinePath = await ctx.layers.traceAlphaOutline(composited);

        // The baked pixels ARE the transform: reset the pose and re-anchor on
        // the composite bounds center (world coords, half-pixel aligned — even
        // dimensions integer, odd .5 — same convention as resizeCanvas). The
        // bounds are tight by construction: the composite ran on the
        // selection-derived ROI (see above), so the new asset carries no
        // historical padding. Product-record conventions come from the shared
        // bake primitive (services/baking.ts).
        const bounds = composited.bounds;
        const record = ctx.layers.bakedLayerPatch(bounds, {
          snapHalf: true,
          outlinePath: outlinePath ?? undefined,
          // flip UNCHANGED: the composite's pose scale is signed, so a
          // mirror drag is already baked INTO the pixels — resetting flip
          // here would mirror the baked asset a second time (negative ×
          // negative = the fragment visually snaps back to unmirrored,
          // diverging from the mirrored selection).
          flip: exchange.flip,
        });

        const bakedPatch: Partial<Layer> = {
          assetId: newAssetId,
          src: newUrl,
          ...record,
          // Snap-to-birth compares against this anchor; a stale one would
          // snap the baked fragment back to its pre-transform position.
          birthCenter: { cx: record.cx!, cy: record.cy! },
          // The declaration must MERGE into the session metadata: the
          // exchange carries the session hole pointer (activeHoleMaskId)
          // through transform bakes — replacing metadata wholesale would
          // sever the session's hole link.
          metadata: {
            ...exchange.metadata,
            physicalPixels: true,
            clipTool: activeFrame.latestClipTool,
          },
        };

        // nextConfinement was derived above (selection-first ROI); the
        // coupled pair write below rides it in this same undoable step.

        // ── Flash-free handover ──
        // The committed write below only becomes visible after React renders;
        // until then the live gesture overlays (buffered pose + scale
        // transient) are what is on screen. Publishing the baked state into
        // the fast-track buffer FIRST makes the very next frame show the baked
        // asset at its baked pose (the scale overlay stands down by itself: it
        // is keyed to the pre-bake asset). The buffer holds exactly the values
        // being committed, so clearing it LATE is harmless — it is cleared
        // only once the committed state is observed to carry the new asset.
        ctx.actions.fast.overrideLayer(activeFrame.id, exchange.id, bakedPatch);

        ctx.layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(exchange.id).patch(bakedPatch);
        });
        // The bake zeroes the layer rotation (it lives in the pixels now); the
        // session keeps the running total so a size reset can restore it.
        // A LOCAL-FRAME (ψ) scale gesture carries `rotation = θ` as part of
        // its linear map `O(θ)·S·R(−θ)` — a render-slot artifact, NOT a
        // rotation the user performed: the map preserves the solved frame's
        // axes, so the true orientation is unchanged and ψ-bakes must not
        // count into the accumulated rotation (accounting them double-counts
        // the angle and knocks the HUD/solve basis off-axis on the NEXT
        // gesture).
        const rotationDelta = sourceAngle !== 0
          ? 0
          : rotation - exchange.rotation;
        const sizeChanged = scale !== 1 || scaleY !== 1;
        const sessionChanged = rotationDelta !== 0 || (sizeChanged && !session.resized);
        const sessionFrame = ctx.actions.fast.latestFrame(activeFrame.id) ?? activeFrame;
        const framePatch = {
          ...(nextConfinement ? { confinement: nextConfinement } : {}),
          ...(sessionChanged
            ? writePeelSession(sessionFrame, {
                ...session,
                accRotation: (session.accRotation ?? 0) + rotationDelta,
                resized: session.resized || sizeChanged,
              })
            : {}),
        };
        if (Object.keys(framePatch).length > 0) {
          ctx.actions.updateFrame(activeFrame.id, framePatch);
        }

        await awaitCommittedLayerAsset(ctx, activeFrame.id, exchange.id, newAssetId);
        ctx.actions.fast.discardLayerDraft(exchange.id);
        await nextAnimationFrame();
      } catch (err) {
        // Reachable ONLY from the three allocation stages above: every state
        // write and the fast-track hand-over publication happen strictly
        // after the last await — so at this point the session is still the
        // untouched 'peeled' record and no bake hand-over exists. That is
        // the delta to the mergeExchange catch discipline (which must undo
        // its 'committing' adjudication): here there is nothing to roll
        // back, only the user-facing feedback to give.
        console.error('[Bake] Failed to bake fragment transform:', err);
        ctx.actions.setInteraction({ hud: { message: 'Bake failed — try again.', type: 'error' } });
      }
    }
  } as EditorCommand<{ pose: TransformParams }, Promise<void>>,

  /**
   * resetTransform — "reset size": puts the fragment back on its ORIGINAL
   * pixels (the shared source asset and crop captured at peel time) at its
   * original size, while keeping where the user put it and how they turned
   * it: the restored content is centered on the current content center and
   * oriented by origin rotation + accumulated rotation. A mirroring scale is
   * part of the size and resets with it. The selection follows by the same
   * rigid map from its peel-time shape. One undoable step.
   *
   * Recovering source pixels (not un-scaling the baked ones) means a reset
   * is lossless even after several shrink/enlarge bakes.
   */
  resetTransform: {
    id: CMD_PEEL_RESET_TRANSFORM,
    name: 'Reset Fragment Size',
    undoable: true,
    execute: (ctx: EditorContextValue): void => {
      const { activeFrame, geometry } = ctx;
      if (!activeFrame) return;
      const session = readPeelSession(activeFrame);
      if (!session || session.status !== 'peeled' || !session.origin) return;
      const resolved = resolveSessionParticipants(ctx, activeFrame, session);
      if (!resolved) return;
      const { exchange } = resolved;
      const origin = session.origin;
      // Size never changed (rotation alone does not count) → nothing to reset.
      if (!session.resized) return;

      const currentCenter = geometry.transform.fragmentContentCenter(
        geometry.transform.fragmentPoseFromLayer(exchange),
      );
      const rotation = geometry.transform.normalizeAngle(origin.layer.rotation + (session.accRotation ?? 0));
      const vr = origin.layer.visibleShape?.rect;
      const visibleOffset = { x: vr?.x ?? 0, y: vr?.y ?? 0 };
      const anchor = geometry.transform.computeFragmentCenter(currentCenter, visibleOffset, rotation, origin.layer.flip);

      const restored = {
        assetId: origin.layer.assetId,
        src: origin.layer.src,
        cx: anchor.x,
        cy: anchor.y,
        rotation,
        scale: 1,
        flip: { ...origin.layer.flip },
        bounding: { ...origin.layer.bounding },
        visibleShape: origin.layer.visibleShape,
        adjustMasks: origin.layer.adjustMasks,
        birthCenter: { cx: anchor.x, cy: anchor.y },
      };

      // Selection: the peel-time shape carried rigidly from the origin pose
      // to the restored pose (same asset, same crop — translation + rotation).
      const nextConfinement = origin.confinement
        ? geometry.transform.followFragmentSelection(
            origin.confinement,
            geometry.transform.fragmentPoseFromLayer({ ...exchange, ...origin.layer }),
            geometry.transform.fragmentPoseFromLayer({ ...exchange, ...restored }),
            activeFrame,
          )
        : null;

      ctx.layers.updateLayer(activeFrame.id, (tx) => {
        tx.edit(exchange.id).patch(restored);
      });
      const sessionFrame = ctx.actions.fast.latestFrame(activeFrame.id) ?? activeFrame;
      ctx.actions.updateFrame(activeFrame.id, {
        ...(nextConfinement ? { confinement: nextConfinement } : {}),
        ...writePeelSession(sessionFrame, { ...session, resized: false }),
      });
    }
  } as EditorCommand<void, void>,

  /**
   * settlePeel — THE single convergence API for every peel exit path
   * (space-bar toggle exit, Enter commit, outside-click clear, Cmd+D,
   * Esc cancel, ClipOverlay unmount fallback). Callers never need to know
   * what happened before they arrived; `settle` asks the session record.
   *
   * Guarantees:
   *   - No session record → zero-cost no-op (keeps the space-bar exit
   *     latency imperceptible).
   *   - Commit in flight (lock held, or a visible 'committing' status) →
   *     this call is VOID. Esc during committing means "nothing to do",
   *     never "queue a rollback behind the commit".
   *   - Residue 'committing' (a persisted mid-commit value that survived a
   *     refresh; the reducer queue it belonged to is gone) → folded back to
   *     'peeled' so the session stays retryable.
   *   - Dangling record (host/exchange died under it) → cleared, no-op.
   *   - The lock is released in `finally` — no exception path may leak it.
   *
   * `clearSelection` (commit only) drops the selection inside the same undo
   * step when — and only when — the commit lands.
   *
   * Resolves `true` exactly when a commit LANDED (fragment promoted, record
   * deleted). Callers must branch on this value, never on a state re-read:
   * the store's visible state lags the commit's writes until React renders,
   * so a re-read right after the await still shows the session.
   */
  settleExchange: {
    id: CMD_PEEL_SETTLE,
    name: 'Settle Peel Session',
    undoable: false,
    execute: async (ctx: EditorContextValue, payload: { mode: 'commit' | 'discard'; clearSelection?: boolean }): Promise<boolean> => {
      const frame = ctx.activeFrame;
      if (!frame) return false;
      if (payload?.mode !== 'commit' && payload?.mode !== 'discard') return false;

      // In-flight adjudication: any concurrent settle is void, not queued.
      if (peelSettleInFlight) return false;

      const session = readPeelSession(frame);
      if (!session) return false; // zero-cost short-circuit — no undecided session
      if (session.status !== 'peeled') return false; // a commit is adjudicated: this call is void, never queued
      // (A 'committing' value seen after a refresh cannot happen here: the
      // drafts sanitizer stores codec-VALIDATED payloads, so the hydrate
      // whitelist folds persisted mid-commit residue back to 'peeled'.)

      // Dangling record → clear, nothing to settle.
      if (!resolveSessionParticipants(ctx, frame, session)) return false;

      peelSettleInFlight = true;
      // Self-ledgered undo step. settle runs as a noundo command, and right
      // after an undo the history has NO open checkpoint: unbracketed writes
      // would then land outside every recorded step, and the next undo would
      // apply a step's patches to a frame they no longer describe (Immer
      // "path doesn't resolve" on drafts/peel). Opening a boundary here and
      // closing it in `finally` makes the settle its own step in every
      // history state — the same begin/commit bracketing a gesture uses.
      ctx.actions.history.commitCheckpoint(frame.id);
      try {
        if (payload.mode === 'commit') {
          // ── Transform-gesture interleave ("pose first, then commit") ──
          // A transform gesture may still hold the pointer while the user
          // hits Space/Enter. mergeExchange composites COMMITTED state, so
          // the in-flight pose (which lives in the gesture's volatile
          // channels) must be baked into the exchange pixels FIRST, in this
          // same call stack, before the promotion runs. The consume marks
          // the gesture's own pointer-up bake as done. The transient is
          // cleared only AFTER the bake lands: the bake pixels ≡ preview
          // pixels, so the live scale overlay hands over to the baked asset
          // without a flash.
          const inflightPose = consumeInflightFragmentTransform(frame.id, session.exchangeId);
          if (inflightPose) {
            await PEEL_COMMANDS.applyTransform.execute(ctx, { pose: inflightPose });
            ctx.actions.fast.setTransient('fragmentTransform', null);
          }
          const landed = await PEEL_COMMANDS.mergeExchange.execute(ctx);
          // Dropping the selection rides INSIDE the bracket so the landing
          // and the clear are one undo step.
          if (landed && payload.clearSelection) {
            ctx.actions.updateFrame(frame.id, { confinement: null });
          }
          return landed;
        } else {
          // Discard abandons the whole session — any in-flight transform pose
          // dies with it. Retract the gesture registration and its transient
          // so the handler's pointer-up finds nothing to bake.
          if (consumeInflightFragmentTransform(frame.id, session.exchangeId)) {
            ctx.actions.fast.setTransient('fragmentTransform', null);
          }
          PEEL_COMMANDS.discardExchange.execute(ctx);
          return false;
        }
      } finally {
        ctx.actions.history.commitCheckpoint(frame.id);
        peelSettleInFlight = false;
      }
    }
  } as EditorCommand<{ mode: 'commit' | 'discard' }, Promise<boolean>>
};
