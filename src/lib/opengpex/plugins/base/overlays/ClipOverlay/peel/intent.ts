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

/**
 * intent.ts — the SINGLE decision table for the Cmd-over-selection
 * gesture arbitration, shared by the pointer ROUTING half
 * (`move.ts :: test()`) and the cursor DISPLAY half (`usePeelCursor`).
 *
 * Keeping one table is the anti-drift contract: if the two halves ever
 * disagree, the cursor would promise a gesture the dispatcher refuses (or
 * silently allow). Both consumers classify the same three inputs — whether
 * the Cmd/Ctrl spring is held, whether Alt is co-held, and whether the
 * pressed/hovered point is inside the existing selection with an active
 * exchange fragment — and receive the same verdict.
 *
 * Mode independence: peel is a document-level gesture over the frame-level
 * selection entity (`frame.confinement`), so the arbitration below knows
 * nothing about pan/clip. Only two mode-flavored knobs exist, both supplied
 * by the caller:
 *
 *   - pointer routing: a BARE drag (no spring) inside the selection moves
 *     the selection itself only in clip mode; in pan mode the bare drag
 *     belongs to layer-move (the pre-existing "bare drag = move the layer"
 *     behavior), so the caller passes `allowsSelectionMove: false` and
 *     receives null (fall through to the existing dispatch).
 *   - cursor display: the peel cursors are declared by a workspace-level
 *     hook that is mode-agnostic; when the spring is not held it writes
 *     nothing (null), letting the boolean-draw cursors (Shift/Alt alone)
 *     and the tool base cursor win.
 */

/** Verdict of the gesture arbitration table. */
export type PeelGestureIntent =
  /** Cmd over a non-fragment selection interior: peel the pixels out.
   * `isCopy` = Alt co-held (stamp a copy, leave the host intact). */
  | { kind: 'peel'; isCopy: boolean }
  /** Cmd over the selection interior while the EXCHANGE fragment is the
   * active layer: drag the existing fragment (selection box + fragment
   * follow the pointer). Not a peel — the fragment already exists. */
  | { kind: 'fragment-move' }
  /** Bare drag (no spring) over the selection interior in a mode that owns
   * selection moves (clip). Translate the selection box only. */
  | { kind: 'selection-move' };

export interface PeelGestureInput {
  /** Cmd/Ctrl spring held. The dispatcher only consults this handler (or
   * layer-move) while the channel is engaged, so `meta: false` verdicts
   * below never collide with a spring-filtered dispatch. */
  meta: boolean;
  /** Alt co-held. Read ONLY inside the meta branch: Alt alone means the
   * boolean difference draw (cursor) / a bare modifier drag, never peel. */
  alt: boolean;
  /** The active layer is the exchange fragment of the selection's host. */
  isExchangeActive: boolean;
  /** Whether a bare drag inside the selection may translate the selection
   * (clip mode). In pan mode this is false: the bare drag belongs to
   * layer-move and this resolver must yield (null). */
  allowsSelectionMove: boolean;
}

/**
 * Resolve the gesture intent for a press/hover over a selection interior.
 * Returns null when the press belongs to the pre-existing dispatch (pan
 * bare drag → layer-move) and this table claims nothing.
 */
export function resolvePeelGestureIntent(input: PeelGestureInput): PeelGestureIntent | null {
  if (input.meta) {
    if (input.isExchangeActive) {
      // Cmd+Alt over the fragment: stamp a copy of it (COPY). Cmd alone:
      // drag the existing fragment — moving beats re-peeling.
      return input.alt ? { kind: 'peel', isCopy: true } : { kind: 'fragment-move' };
    }
    return { kind: 'peel', isCopy: input.alt };
  }
  return input.allowsSelectionMove ? { kind: 'selection-move' } : null;
}

/**
 * Map a meta-branch verdict to the hover cursor value it promises, or null
 * when the cursor must yield. Mirrors the routing table above exactly:
 *
 *   peel + copy    → CLIP_PEEL_COPY_CURSOR (stamp-copy glyphs)
 *   peel + cut     → CLIP_PEEL_CUT_CURSOR   (scissors glyphs)
 *   fragment-move  → null (the spring channel already shows the generic
 *                    move cursor; a hover refinement would add nothing)
 *
 * The consumer passes the meta verdict only while the spring is engaged;
 * for every other input (spring released, pointer outside the selection)
 * it passes null and the resolver-yield contract keeps the boolean-draw
 * and tool cursors authoritative.
 */
export function peelCursorForIntent(intent: PeelGestureIntent | null): string | null {
  if (!intent || intent.kind !== 'peel') return null;
  return intent.isCopy ? 'copy' : 'cut';
}
