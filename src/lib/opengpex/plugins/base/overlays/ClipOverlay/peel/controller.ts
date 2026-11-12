/**
 * OpenGPEX - An Open-source, Web-based Graphics and photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors.
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
 * peel/controller.ts — the runtime-state owner of the peel session family.
 *
 * The peel process carries THREE state classes with different lifecycles:
 *
 *   1. DOCUMENT lifecycle  — the `frame.drafts['peel']` record (./session.ts):
 *      persisted, codec-validated, undo-tracked. NOT owned here.
 *   2. RUNTIME mutex       — the settle in-flight lock (below): synchronous,
 *      store-independent, immune to mid-await resets. It guards one in-memory
 *      call chain, not a document fact — exactly why it must NOT live in the
 *      persisted record (a persisted 'committing' status can survive a
 *      refresh as residue; this lock cannot, which is what makes it the
 *      right witness for "a commit is running RIGHT NOW").
 *   3. GESTURE transient   — the in-flight fragment-transform slot (below):
 *      process-local, lives only while a pointer drag is live, consumed by
 *      the settle or retracted at pointer-up. Never reaches the store.
 *
 * One module owns classes 2 and 3 so the peel entry commands (commitExit /
 * discardExit) never have to remember to guard, and the state never leaks
 * into the document. The document record stays in ./session.ts by design.
 */

import type { EditorContextValue, TransformParams } from '@opengpex/editor/core/types';
import { ClipOverlayAPI, type ClipOverlayConfig, PeelAPI } from '../protocols';
import { readPeelSession } from './session';

// ─── Class 2: the settle mutex ───────────────────────────────────────────────

/**
 * The peel settle lock — the command-layer mutex, held for the whole run of
 * a settle (commit or discard), the commit's GPU bake included.
 *
 * The store is a React reducer whose visible state only refreshes after a
 * render: a write dispatched mid-command is invisible to readers on the same
 * stack and for the whole async window that follows. While a commit is in
 * flight, a concurrently arriving settle (Esc, unmount fallback, ...) would
 * read the stale pre-commit session and could roll a COMPLETED peel back,
 * destroying a permanent hole. The lock makes such calls VOID (not queued:
 * during committing, Esc means "nothing to do").
 */
let settleInFlight = false;

/** Whether a settle is running at this moment. */
export function isPeelSettleInFlight(): boolean {
  return settleInFlight;
}

/** Owned by the settle command: taken before its first write, released in `finally`. */
export function setPeelSettleInFlight(value: boolean): void {
  settleInFlight = value;
}

// ─── Class 3: the in-flight fragment transform slot ─────────────────────────

export interface InflightFragmentTransform {
  frameId: string;
  exchangeId: string;
  /** The gesture's latest pose, read fresh when the settle consumes it. */
  getPose: () => TransformParams;
}

/**
 * Module-level in-flight transform slot. `consumed` marks "a settle already
 * baked this pose": the handler checks it at pointer-up so the pose is never
 * baked twice.
 */
let inflightTransform: (InflightFragmentTransform & { consumed: boolean }) | null = null;

/** Handler gesture open: publish the live pose source. */
export function registerInflightFragmentTransform(t: InflightFragmentTransform): void {
  inflightTransform = { ...t, consumed: false };
}

/** Handler gesture closed (pointer-up handled it, or cancelled): retract. */
export function clearInflightFragmentTransform(): void {
  inflightTransform = null;
}

/**
 * Settle-side consume: returns the in-flight pose when the registration
 * matches the session's frame and exchange, marking it consumed so the
 * handler's own pointer-up bake becomes a no-op. Synchronous by contract —
 * the read-mark pair must complete inside one call stack (no await between)
 * or a pointer-up landing in between would double-bake.
 */
export function consumeInflightFragmentTransform(frameId: string, exchangeId: string): TransformParams | null {
  if (!inflightTransform || inflightTransform.consumed) return null;
  if (inflightTransform.frameId !== frameId || inflightTransform.exchangeId !== exchangeId) return null;
  inflightTransform.consumed = true;
  return inflightTransform.getPose();
}

/** Handler pointer-up check: did a settle already bake this gesture's pose? */
export function isInflightFragmentTransformConsumed(): boolean {
  return !!inflightTransform?.consumed;
}

/** Test isolation: force all runtime slots open/clear between tests. */
export function resetPeelRuntimeForTests(): void {
  settleInFlight = false;
  inflightTransform = null;
  convergencePending = false;
}

// ─── Class 3: the selection-convergence handoff flag ─────────────────────────

/**
 * The peel command rewrites the confinement onto the cut geometry while the
 * selection move gesture owns the selection: the gesture would overwrite the
 * converged polygon with the once-drawn outline on its very next move. The
 * command marks this flag after writing; the gesture consumes it once and
 * adopts the live confinement as its new translation base. Same state class
 * as the two slots above — process-local, never document state.
 */
let convergencePending = false;

/** Owned by the peel command: set right after the converged confinement is written. */
export function markSelectionConverged(): void {
  convergencePending = true;
}

/** Owned by the selection move gesture: consume once per gesture. */
export function consumeSelectionConvergence(): boolean {
  const pending = convergencePending;
  convergencePending = false;
  return pending;
}

// ─── High-level exit tails (owned here, dispatched by the entry plugins) ────

/**
 * Commit any undecided peel session, then apply the selection-lifecycle
 * preference: the ants are dropped when the commit lands, or CONVERGED onto
 * the promoted fragment when the keep preference is on. The selection is
 * also KEPT when the commit did not land (merge failure / in-flight commit)
 * — the floating fragment must stay glued to its selection for the retry.
 * With no session this is a plain deselect (not gated by the preference: a
 * deselect action, not an operation). The landed/failed decision is made
 * inside settle from its RESOLVED outcome, never from a state re-read.
 */
export async function commitExit(ctx: EditorContextValue): Promise<void> {
  const frame = ctx.activeFrame;
  if (!frame) return;
  if (!readPeelSession(frame)) {
    ctx.actions.updateFrame(frame.id, { confinement: null });
    return;
  }
  await ctx.actions.executeCommand(PeelAPI.commands.settleExchange.uid, {
    mode: 'commit',
    clearSelection: ((ctx.state.pluginConfig as Record<string, Partial<ClipOverlayConfig>> | undefined)?.[ClipOverlayAPI.configKey]?.keepClipBoxAfter !== true),
  });
}

/**
 * Discard any undecided peel session, then drop the selection. The
 * implicit-cancel semantics (click outside the floating fragment, Esc):
 * the fragment and its glued selection disappear and the slot clears, so a
 * replacement selection can start immediately. NOT gated by the keep
 * preference — a discard is a cancellation, not a landed operation.
 */
export async function discardExit(ctx: EditorContextValue): Promise<void> {
  const frame = ctx.activeFrame;
  if (!frame) return;
  if (readPeelSession(frame)) {
    await ctx.actions.executeCommand(PeelAPI.commands.settleExchange.uid, { mode: 'discard' });
  }
  ctx.actions.updateFrame(frame.id, { confinement: null });
}
