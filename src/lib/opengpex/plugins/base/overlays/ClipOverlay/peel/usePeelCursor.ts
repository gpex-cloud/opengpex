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

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useEditorState, useEditorServices, useVolatileInteraction } from '@opengpex/editor/core/context';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { CLIP_PEEL_CUT_CURSOR, CLIP_PEEL_COPY_CURSOR } from '@opengpex/editor/icons';
import { hitTestSelectionInterior } from '../interactions/hitTest';
import { resolvePeelGestureIntent, peelCursorForIntent } from './intent';
import { ClipOptionsAPI } from '../../../options/ClipOptions/protocols';

/**
 * usePeelCursor — the cursor DISPLAY half of the peel gesture
 * (pointer ROUTING lives in ClipOverlay's move handler; both consume the
 * same arbitration table in `interactions/peelIntent.ts`, so the cursor can
 * never promise a gesture the dispatcher would refuse).
 *
 * This hook must live at the WORKSPACE level (mounted by ClipOptionsMain,
 * which is a persistent OPTION_BAR component) instead of inside
 * `useClipCursor`: the clip overlay only mounts in clip / Re-Canvas, while
 * peel is a mode-agnostic gesture that also fires in pan — a hover writer
 * owned by the overlay would leave pan without any peel cursor at all.
 *
 * Modifier-key reclassification contract: hover declarations are driven by
 * pointermove, which by itself never fires on a key press — a Cmd press over
 * the selection would leave the stale pre-press hover value in the slot
 * until the next pointer motion. This hook therefore implements the full
 * modifier-sensitive reclassification triad:
 *
 *   1. The last pointer POSITION is cached (modifier truth is NEVER cached —
 *      it is read live from the `springChannels` channel state, which
 *      SpringKeyManager maintains across keydown/keyup/window-blur);
 *   2. The `springChannels` volatile field is subscribed field-level, and
 *      every channel flip IMMEDIATELY re-classifies at the cached position
 *      and re-declares the hover value — the cursor answers the key press,
 *      not the next mouse move;
 *   3. The element probe (gizmo yield check) resolves through
 *      `document.elementFromPoint` so a re-classification without pointer
 *      motion hits the same element the pointer is parked on.
 *
 * Cursor contract (mirrors move.ts :: test() through the shared table):
 *   - Cmd held + pointer inside the selection        → CUT scissors
 *   - Cmd + Alt held + pointer inside the selection  → COPY stamp glyphs
 *   - Cmd held over the selection interior while the exchange fragment is
 *     the active layer                               → nothing declared
 *     (fragment drag — the spring channel already shows 'move')
 *   - Everything else                                → nothing declared
 *     (Shift/Alt alone keep the boolean-draw cursors authoritative; the
 *     pointer outside the selection keeps the spring 'move'; the tool base
 *     cursor survives whenever no refinement applies)
 *
 * Writer coordination: the CursorService exposes ONE hover slot, and
 * `useClipCursor` (clip overlay) deliberately skips all writes while the
 * Cmd spring is engaged — this hook is the sole writer on that channel.
 * A single write-deduplicating ref keeps every transition (mode switches,
 * gesture start/end, Cmd release) from leaving a stale peel cursor behind.
 */
export function usePeelCursor() {
  const { actions, geometry } = useEditorServices();
  const { state, activeFrame } = useEditorState();
  const springChannels = useVolatileInteraction('springChannels');

  const frameRef = useRef(activeFrame);
  useLayoutEffect(() => { frameRef.current = activeFrame; });

  const isInteractingRef = useRef(!!state.interaction.isInteracting);
  useLayoutEffect(() => { isInteractingRef.current = !!state.interaction.isInteracting; });

  // Admission gate: peel is admissible exactly where the move handler's
  // mode gate admits it — clip or pan, never Re-Canvas (the canvas-resize
  // modal owns every press and suppresses the spring keys).
  const admissionRef = useRef(false);
  useLayoutEffect(() => {
    const mode = state.interaction.interactionMode;
    const inReCanvas = !!state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
    admissionRef.current = !inReCanvas && (mode === 'clip' || mode === 'pan');
  });

  // Spring channel mirror for the pointermove closure (the channel state,
  // not the event's modifier flags, is the modifier truth — the manager
  // keeps it correct across keydown/keyup and window blur).
  const channelsRef = useRef(springChannels);
  useLayoutEffect(() => { channelsRef.current = springChannels; }, [springChannels]);

  // Last pointer POSITION in client coordinates — the cached half of the
  // reclassification contract. Null until the first pointermove; a channel
  // flip before any motion has nothing to reclassify (no peel declaration
  // could exist yet either).
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  // Last value this hook pushed into the shared hover slot. The hook only
  // speaks when its verdict CHANGES, so it never clobbers the other hover
  // writers (clip entity hover, ReCanvas edge cursors) that own the slot
  // whenever this hook has nothing to declare.
  const lastDeclaredRef = useRef<string | null>(null);

  // Write-deduplicated declaration into the shared hover slot. A ref keeps
  // the listener effects below stable across re-renders.
  const declareRef = useRef<(value: string | null) => void>(() => {});
  useLayoutEffect(() => {
    declareRef.current = (value: string | null) => {
      if (lastDeclaredRef.current === value) return;
      lastDeclaredRef.current = value;
      actions.fast.cursor.notifyHover(value);
    };
  });

  // The classification pass, shared verbatim by both trigger sources
  // (pointermove and spring-channel flips). Reads modifier truth from the
  // channel mirror; everything geometric is recomputed per call.
  const classifyRef = useRef<(x: number, y: number) => void>(() => {});
  useLayoutEffect(() => {
    classifyRef.current = (x: number, y: number) => {
      // The gizmo hit zones own their own hover declaration (the gizmo's
      // internal CursorService sync) — hands off without clearing so the
      // two writers never fight over the same probe. elementFromPoint (not
      // a pointer event target) so a key-press reclassification with a
      // stationary pointer resolves the same element.
      const el = document.elementFromPoint(x, y);
      if (el?.closest?.('[data-gizmo-cursor]')) return;

      const channels = channelsRef.current;

      // Pointer outside peel jurisdiction (modal active, wrong mode, gesture
      // in flight, spring released): retract OUR declaration exactly once and
      // stay silent afterwards, leaving the slot to the other writers. The
      // retract-once pattern is what removes a lingering peel cursor after a
      // Cmd release or a mode switch in pan mode, where no other writer
      // would overwrite it.
      if (!admissionRef.current || isInteractingRef.current || !channels.meta) {
        declareRef.current(null);
        return;
      }

      const frame = frameRef.current;
      if (!frame) { declareRef.current(null); return; }

      const box = getClipBox(frame);
      if (!box) { declareRef.current(null); return; }

      // Project pointer → canvas-local (same recipe as useClipCursor).
      const container = document.querySelector('.editor-viewport-container');
      if (!container) return;
      const domRect = container.getBoundingClientRect();
      const vx = x - domRect.left;
      const vy = y - domRect.top;
      const currentCam = actions.fast.latestCamera(frame.id);
      const worldPt = geometry.space.screenToWorld(vx, vy, frame, currentCam);
      const canvasPt = geometry.space.worldToLocal(worldPt.x, worldPt.y, frame);

      // Hit-test follows what was DRAWN (rect / true ellipse / polygon rings
      // — the same predicate the move handler dispatches on).
      if (!hitTestSelectionInterior(canvasPt, box)) { declareRef.current(null); return; }

      const activeLayer = frame.activeLayerId
        ? frame.layers.byId[frame.activeLayerId]
        : undefined;
      const intent = resolvePeelGestureIntent({
        meta: true,
        alt: !!channels.alt,
        isExchangeActive: activeLayer?.role === 'exchange',
        allowsSelectionMove: false,
      });
      const kind = peelCursorForIntent(intent);
      declareRef.current(kind === 'copy' ? CLIP_PEEL_COPY_CURSOR : kind === 'cut' ? CLIP_PEEL_CUT_CURSOR : null);
    };
  });

  // Trigger source 1 — pointer motion: refresh the position cache, then
  // classify at the fresh position.
  useEffect(() => {
    const onPointerMove = (ev: PointerEvent) => {
      lastPointerRef.current = { x: ev.clientX, y: ev.clientY };
      classifyRef.current(ev.clientX, ev.clientY);
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      declareRef.current(null);
    };
  }, []);

  // Trigger source 2 — spring-channel flips (the reclassification
  // contract): a Cmd/Alt press or release while the pointer is parked
  // re-classifies IMMEDIATELY at the cached position, so the cursor answers
  // the key, not the next mouse move.
  useEffect(() => {
    const cached = lastPointerRef.current;
    if (cached) classifyRef.current(cached.x, cached.y);
  }, [springChannels]);
}
