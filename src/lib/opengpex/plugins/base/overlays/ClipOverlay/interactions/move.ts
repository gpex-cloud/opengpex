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

import {
  InteractionHandler,
  InteractionEvent,
  LocalRect,
  LocalPolygon,
  asLocalRect,
} from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { readPeelSession } from '../peel/session';
import * as P from '../protocols';
import { createTransformHandler, TransformIntent } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import {
  ClipOptionsAPI,
} from '../../../options/ClipOptions/protocols';
import { hitTestSelectionInterior } from './hitTest';
import { resolvePeelGestureIntent } from '../peel/intent';

/**
 * createSelectionMoveHandler — Unified selection move + peel handler.
 *
 * This handler is tool-agnostic: it operates on ANY already-established selection
 * (LocalShape from rect/ellipse, or LocalPolygon from lasso/wand), providing:
 *
 *   - **Move**: drag inside existing selection → translate selection by (dx, dy)
 *   - **Peel**: Meta+drag inside selection → fragment the image layer and
 *     move the fragment (delegating to `peelToExchange`)
 *
 * Architecture: wraps `createTransformHandler` to inherit its built-in capabilities:
 *   - `InteractionMath.snapAndSync()` → smart guide alignment
 *   - Canvas clamp
 *   - Physical pixel alignment
 *   - Proper transaction lifecycle
 *
 * For polygon selections, the TransformHandler operates on the polygon's bounding
 * rect. The actual polygon vertices are translated by the rect's position delta
 * in `onUpdate`.
 *
 * Priority: 130 (higher than clipbox=100, lasso/wand=110) so that clicking inside
 * an existing selection is intercepted here BEFORE the creation handlers can fire.
 * Clicks OUTSIDE the selection fall through to the tool's creation handler.
 *
 * Mode admission (pan/clip unification): the handler runs in BOTH selection
 * modes and behaves identically in both — a bare drag inside the selection
 * translates the selection (and a peeled fragment glued to it), Cmd peels.
 * Pan and clip differ only in what the selection OFFERS beyond moving: clip
 * draws new selections and shows the transform gizmo; pan does neither. The
 * cost is deliberate: inside a selection, pan no longer bare-drags the layer
 * underneath (dragging what you see outlined beats moving what is behind it).
 * A static click inside the selection clears it only in clip — in pan it is
 * a no-op, never a silent selection loss.
 */
export const createSelectionMoveHandler = (): InteractionHandler => {
  // ─── Closure state ─────────────────────────────────────────────────────────
  let startPolygon: LocalPolygon | null = null;
  let initialRect: LocalRect = asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
  let hasPeeled = false;
  let feedbackDeclared = false; // the gesture feedback declaration is issued once per gesture
  /**
   * Why this gesture's peel can never start. Resolved once at the 1px
   * trigger threshold, mirroring the peel command's own admission gates:
   * 'locked' — a CUT peel on a locked host (the command would refuse with a
   * HUD error); 'silent' — the resolved host is not an image layer (the
   * command no-ops without feedback). While a refusal stands the gesture
   * must not translate the selection either: the peel never happened, so
   * there is no fragment to follow and a sliding selection would be pure
   * damage.
   */
  let peelRefusal: 'locked' | 'silent' | null = null;

  return createTransformHandler({
    id: 'clip-selection-move',
    priority: 130,
    // Cmd inside the selection = peel (Cmd+Alt = copy-peel) — owns Cmd over its hit region.
    springOverride: 'meta',

    test: (e: InteractionEvent): TransformIntent | null => {
      // ─── Mode admission ───────────────────────────────────────────────
      // Peel is a document-level gesture over the frame-level selection
      // entity, so this handler admits BOTH selection modes. The only
      // behavioral difference is the bare-drag branch at the bottom: clip
      // translates the selection, pan yields it to layer-move. Re-Canvas
      // keeps its own move logic in the clipbox handler (always rect).
      const mode = e.state.interaction.interactionMode;
      const inClip = mode === 'clip';
      const inPan = mode === 'pan';
      const inReCanvas = !!e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
      if (inReCanvas || !(inClip || inPan)) return null;

      // ─── Existing selection check ─────────────────────────────────────
      const box = getClipBox(e.activeFrame);
      if (!box) return null;

      const me = e.nativeEvent as MouseEvent;

      // Skip UI elements
      const target = me.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return null;

      // Yield to the shared TransformGizmo hit zones (priority 120 scale
      // handles + rotation dot). The gizmo mounts INSIDE the move surface,
      // so target.closest('[data-handle]') below would otherwise match
      // through the handles and turn every handle press into a selection
      // move — this handler runs at a higher priority and must stand down
      // whenever the press landed on a handle.
      if (target.closest('[data-gizmo-handle], [data-gizmo-rotate]')) return null;

      // ─── Hit-test: is click inside the existing selection? ─────────────
      // Pure geometry (single source of truth shared with hover consumers):
      // rect membership, true ellipse membership (never the bbox — the DOM
      // move surface carries border-radius:50%, so its hit region is the same
      // ellipse), or polygon rings for irregular selections.
      if (!hitTestSelectionInterior(e.point.canvas, box)) return null;

      // ─── Determine operation type ────────────────────────────────────
      // Single shared arbitration table (peel/intent.ts) — the cursor hook
      // consumes the same one, so the pointer can never be promised a
      // gesture this handler would refuse. Both admitted modes own the bare
      // drag inside the selection (selection move, fragment follows).
      const activeLayer = e.activeFrame.activeLayerId
        ? e.activeFrame.layers.byId[e.activeFrame.activeLayerId]
        : undefined;
      const intent = resolvePeelGestureIntent({
        meta: me.metaKey || me.ctrlKey,
        alt: me.altKey,
        isExchangeActive: activeLayer?.role === 'exchange',
        allowsSelectionMove: inClip || inPan,
      });
      if (!intent) return null;
      if (intent.kind === 'peel') return { category: 'custom', sub: 'peel' };
      return { category: 'move' };
    },

    getInitialState: (e: InteractionEvent) => {
      const box = getClipBox(e.activeFrame);
      hasPeeled = false;
      peelRefusal = null;
      feedbackDeclared = false;

      if (!box) {
        startPolygon = null;
        initialRect = asLocalRect({ x: 0, y: 0, w: 0, h: 0 });
        return initialRect;
      }

      // Always capture startPolygon for both regular and irregular selections.
      startPolygon = box;
      initialRect = { ...box.rect };

      return initialRect;
    },

    getConstraints: () => ({
      clamp: true,  // Strict canvas bounds clamping for all selection moves
    }),

    onUpdate: (e: InteractionEvent, newRect: LocalRect, tx, context) => {
      const frame = e.activeFrame;

      // ─── Gesture feedback declaration (once per gesture) ─────────────
      // The wrapper owns the transaction, so the declaration rides the
      // first update: what moves is the SELECTION (the fragment follow is
      // part of the same gesture — one label for the pair). Cleared by the
      // wrapper's transaction commit/abort.
      if (!feedbackDeclared) {
        feedbackDeclared = true;
        tx.declareFeedback({
          kind: 'translate',
          target: 'frame',
          origin: { x: initialRect.x, y: initialRect.y },
          // Pan never shows the dimension label the default 24px clearance
          // reserves space for — tighten the clearance instead of leaving
          // the label slot empty. (Clearance only: the anchor itself keeps
          // following the live selection every frame.)
          ...(e.state.interaction.interactionMode === 'pan' ? { anchorOffsetY: 8 } : {}),
        });
      }

      // ─── Peel mode: trigger peel on threshold ─────────────────────────
      if (context.intent.sub === 'peel' && ((e.nativeEvent as MouseEvent).metaKey || (e.nativeEvent as MouseEvent).ctrlKey)) {
        if (!hasPeeled) {
          if (Math.sqrt(context.dx * context.dx + context.dy * context.dy) >= 1) {
            // Resolve the peel command's own admission gates BEFORE latching
            // the gesture: a refused peel must not hand the drag to the
            // selection-translation branch below, or the selection would
            // slide away under a "Layer is locked" error with no fragment
            // following it. Evaluated once per gesture (the refusal state
            // also suppresses the HUD re-firing on every later move).
            if (peelRefusal === null) {
              const me = e.nativeEvent as MouseEvent;
              const activeLayer = frame.activeLayerId
                ? frame.layers.byId[frame.activeLayerId]
                : undefined;
              // The peel command resolves the host from whichever of the
              // pair holds focus (exchange active → its host).
              const host = activeLayer?.role === 'exchange' && activeLayer.hostId
                ? frame.layers.byId[activeLayer.hostId]
                : activeLayer;
              if (!host || host.type !== 'image') {
                peelRefusal = 'silent'; // the command no-ops quietly — so does the gesture
              } else if (!me.altKey && host.locked) {
                // Copy peels only READ the host and stay available on locked
                // layers; a CUT peel digs the hole and is refused there.
                peelRefusal = 'locked';
                e.actions.setInteraction({ hud: { message: 'Layer is locked', type: 'error' } });
              }
            }
            if (peelRefusal !== null) return;
            hasPeeled = true;
            // Yield to the macrotask queue so the in-flight pointermove batch
            // (and its pending DOM/store writes) settles first — peelToExchange
            // replaces the active layer and focus, which must not race the
            // gesture handler still consuming this same event.
            setTimeout(() => e.actions.executeCommand(P.CMD_PEEL_EXCHANGE, {
              isCopy: (e.nativeEvent as MouseEvent).altKey
            }), 0);
          }
          return; // Don't move until peel is triggered
        }
      }

      // ─── Move: update selection position ──────────────────────────────
      if (startPolygon) {
        const polyDx = newRect.x - initialRect.x;
        const polyDy = newRect.y - initialRect.y;
        const newPoly = e.geometry.polygon.translatePolygon(startPolygon, polyDx, polyDy);
        tx.update({
          confinement: newPoly
        }, 'frame');
      }

      // ─── Sync exchange layer position ─────────────────────────────────
      // The fragment that follows the selection is the SESSION's exchange
      // when one is undecided (the coupled pair must move together even if
      // focus drifted elsewhere mid-session); with no session this is the
      // pre-peel lookup from the focused layer, which moves the always-present
      // blank exchange invisibly.
      {
        const session = readPeelSession(frame);
        const exchangeLayer = session && session.status === 'peeled'
          ? frame.layers.byId[session.exchangeId]
          : (() => {
              if (!frame.activeLayerId) return undefined;
              const activeLayer = frame.layers.byId[frame.activeLayerId];
              return (activeLayer?.role === 'exchange')
                ? activeLayer
                : frame.layers.order
                    .map(id => frame.layers.byId[id])
                    .find(l => l.role === 'exchange' && l.hostId === frame.activeLayerId);
            })();

        if (exchangeLayer) {
          const worldCenter = e.geometry.space.localToWorld(
            newRect.x + newRect.w / 2,
            newRect.y + newRect.h / 2,
            frame
          );
          const vr = exchangeLayer.visibleShape?.rect;
          const vox = vr?.x ?? 0;
          const voy = vr?.y ?? 0;
          const pose = e.geometry.transform.computeFragmentCenter(
            worldCenter,
            { x: vox, y: voy },
            exchangeLayer.rotation,
            exchangeLayer.flip
          );
          tx.update({ cx: pose.x, cy: pose.y }, 'layer', exchangeLayer.id);
        }
      }
    },

    // ── Gesture rules (pre-end interceptors) ──
    gestures: [{
      name: 'static-click-clear',
      match: (ctx) => !ctx.hasMoved
                   && ctx.intent.category === 'move'
                   && !ctx.endModifiers.meta
                   && !ctx.endModifiers.ctrl,
      action: (e) => {
        // Clip only: in pan the selection is moved, never dropped by a
        // stray click.
        if (e.state.interaction.interactionMode !== 'clip') return;
        // A undecided peel session splits the click by side: OUTSIDE the
        // floating selection it is an implicit CANCEL — the fragment and
        // its glued selection vanish (Esc semantics), then the slot clears.
        // INSIDE the selection the click is a NO-OP (user ruling
        // 2026-11-05, reversing the earlier "inside click = settle"):
        // landing the fragment on a stray click feeds the undo-ledger
        // misalignment defect a multi-write step to half-rewind, and an
        // accidental interior tap destroying the session was too hot a
        // trigger. Settling stays with the EXPLICIT entries (Enter /
        // Cmd+D / action bar). No session → the plain Photoshop marquee
        // behavior (click clears the selection).
        const session = readPeelSession(e.activeFrame);
        const poly = e.activeFrame?.confinement;
        if (session && session.status === 'peeled' && poly) {
          // Same shared predicate as the move admission above so the
          // inside/outside split matches how the selection is DRAWN
          // (rect boundary-inclusive, true ellipse, even-odd rings).
          const inside = hitTestSelectionInterior(e.point.canvas, poly);
          if (!inside) {
            e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
          }
          return;
        }
        e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
      },
    }],

    // onEnd ALWAYS executes (framework guarantee). Used for resource cleanup only.
    onEnd: () => {
      hasPeeled = false;
      peelRefusal = null;
      feedbackDeclared = false;
    },
  });
};
