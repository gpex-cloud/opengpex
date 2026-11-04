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
 * peel/session.ts — the explicit session record for the peel command family,
 * stored in `frame.drafts['peel']`. Lives in the ClipOverlay plugin: peel is
 * an interaction-fused feature (its commands read the live selection, focus
 * and gesture registrations), not a reusable core document service, so the
 * whole family (record, inflight slot, commands) is plugin-owned domain
 * knowledge; core only carries the protocol id strings.
 *
 * Before this record existed, "where is the peel session in its lifecycle"
 * had no owner: every caller SNIFFED pixel content (an exchange holding a
 * non-blank bitmap meant "dirty") to reconstruct the answer. After the peel
 * commit became non-destructive (hole stays on the host, fragment promotes
 * to a regular layer), one wrong sniff destroyed a PERMANENT user hole —
 * the stale-read rollback bug this module eliminates. The lifecycle is now
 * DECLARED here:
 *
 *   - record absent                    → no undecided session (commit and
 *                                        discard are both no-ops; a peel
 *                                        creates a fresh record).
 *   - status 'peeled'                  → session undecided. Commit, discard
 *                                        and stamp-drag are all legal.
 *   - status 'committing'              → mergeExchange has been adjudicated
 *                                        (synchronous write issued before
 *                                        the async composite). Every settle
 *                                        call is VOID in this state.
 *   - settled                          → the record is DELETED (no terminal
 *                                        state — absence IS the terminal
 *                                        state; nothing consumes a terminal
 *                                        marker that absence cannot express
 *                                        more cheaply).
 *
 * The record rides the `drafts` container, so it inherits the per-frame undo
 * ledger, the `.gpex` pack/unpack round-trip and the hydrate whitelist for
 * free. The codec below is that whitelist entry (registered by the
 * ClipOptions plugin's `contributions.state.draftCodec`).
 *
 * Two read paths exist by design:
 *   - `readPeelSession` (raw): used by the core commands. Status is
 *     preserved verbatim — the 'committing' adjudication state must stay
 *     visible to the settle machinery while a commit is in flight.
 *   - `peelSessionCodec.validate` (normalizing): used at document hydrate
 *     and by React readers. A persisted 'committing' value is folded back
 *     to 'peeled': a commit interrupted by a page refresh loses its entire
 *     reducer queue (nothing landed), so the recovered session must be
 *     RETRYABLE, not bricked. (Residue 'committing' can also survive hydrate
 *     verbatim — the hydrator keeps the raw payload — so `settle` applies
 *     the same fold when the in-flight lock is free; see peel.ts.)
 */

import type { DraftCodec } from '@opengpex/editor/core/state/drafts';
import { writeFrameDraft } from '@opengpex/editor/core/state/drafts';
import type { Frame, Layer, LocalPolygon } from '@opengpex/editor/core/types';

/** The `frame.drafts` key owned by the peel session. */
export const PEEL_TOOL_ID = 'peel';

/**
 * The fragment exactly as the peel produced it, plus the selection at that
 * moment — the reference a "reset size" restores from. Holds the SOURCE
 * asset (shared with the host) and its crop, so a reset recovers original
 * pixels no matter how many transform bakes replaced the exchange asset.
 */
export interface PeelSessionOrigin {
  /** Exchange fields captured right after the peel. */
  layer: Pick<Layer, 'assetId' | 'src' | 'cx' | 'cy' | 'rotation' | 'flip' | 'bounding' | 'visibleShape' | 'adjustMasks'>;
  /** The selection the fragment was cut with (glued to the origin pose). */
  confinement: LocalPolygon | null;
}

/** Lifecycle of an undecided peel session (absence = settled). */
export type PeelSessionStatus = 'peeled' | 'committing';

export interface PeelSession {
  /** The layer the hole mask lives on (and whose pixels were cut). */
  hostId: string;
  /** The exchange sublayer carrying the fragment (`${hostId}_exchange`). */
  exchangeId: string;
  /**
   * Exact id of the session hole mask on the host. `null` = copy mode
   * (Cmd+Alt): no session hole exists, discard must not touch host masks.
   */
  holeMaskId: string | null;
  status: PeelSessionStatus;
  /** Reset-size reference (absent on records written before it existed). */
  origin?: PeelSessionOrigin;
  /**
   * Rotation (degrees) the transform bakes have accumulated on top of the
   * origin pose. Baked pixels carry it while the layer reads rotation 0, so
   * a size reset needs it to give the restored fragment its orientation back.
   */
  accRotation?: number;
  /**
   * A transform bake changed the fragment's SIZE (a non-unit or mirroring
   * scale). Rotation alone never sets it — "reset size" is offered only
   * when there is a size to reset.
   */
  resized?: boolean;
}

/**
 * Structural guard. Field-shape only: every field present, id fields
 * non-empty strings, status a legal enum member. A payload failing this is
 * treated as "no session" everywhere (degrade-safe, never crash).
 */
export function validatePeelSessionRaw(v: unknown): PeelSession | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Partial<PeelSession>;
  if (typeof s.hostId !== 'string' || s.hostId.length === 0) return null;
  if (typeof s.exchangeId !== 'string' || s.exchangeId.length === 0) return null;
  if (s.holeMaskId !== null && typeof s.holeMaskId !== 'string') return null;
  if (s.status !== 'peeled' && s.status !== 'committing') return null;
  // Optional reset reference: a malformed one degrades to "no reset
  // available" — it must never invalidate the session itself.
  if (s.origin !== undefined && !isValidOrigin(s.origin)) {
    const { origin: _drop, ...rest } = s as PeelSession;
    void _drop;
    return rest as PeelSession;
  }
  if (s.resized !== undefined && typeof s.resized !== 'boolean') {
    return { ...(s as PeelSession), resized: false };
  }
  if (s.accRotation !== undefined && typeof s.accRotation !== 'number') {
    return { ...(s as PeelSession), accRotation: 0 };
  }
  return v as PeelSession;
}

function isValidOrigin(o: unknown): o is PeelSessionOrigin {
  if (!o || typeof o !== 'object') return false;
  const l = (o as PeelSessionOrigin).layer;
  return !!l
    && typeof l.assetId === 'string'
    && typeof l.cx === 'number'
    && typeof l.cy === 'number'
    && typeof l.rotation === 'number'
    && !!l.flip
    && !!l.bounding;
}

/**
 * Raw read for the core command layer: status preserved verbatim, no clone,
 * no codec registration dependency. Callers treat the result as read-only.
 */
export function readPeelSession(frame: Frame | null | undefined): PeelSession | null {
  const payload = frame?.drafts?.[PEEL_TOOL_ID];
  if (!payload) return null;
  return validatePeelSessionRaw(payload);
}

/**
 * Builds the frame patch that stores the session (or deletes the entry when
 * null). Dispatch through `actions.updateFrame(frameId, ...)` — the whole
 * drafts map is replaced while untouched keys keep their references, so a
 * concurrent pen draft is never cloned or invalidated.
 */
export function writePeelSession(frame: Frame, session: PeelSession | null): Pick<Frame, 'drafts'> {
  return writeFrameDraft(frame, PEEL_TOOL_ID, session);
}

/**
 * The peel session codec, registered by the ClipOptions plugin. Normalizing
 * on purpose: a hydrated 'committing' folds to 'peeled' so a refresh landing
 * mid-commit recovers a RETRYABLE session. No `clone` (tiny payload,
 * structuredClone fallback is fine) and no `transform` (the record holds only
 * ids — the hole geometry lives on the host's vectorMasks, which the layer
 * transform pipeline already moves).
 */
export const peelSessionCodec: DraftCodec<PeelSession> = {
  toolId: PEEL_TOOL_ID,
  validate: (v: unknown) => {
    const s = validatePeelSessionRaw(v);
    if (!s) return null;
    return s.status === 'peeled' ? s : { ...s, status: 'peeled' };
  },
};



/**
 * The fragment's TRUE on-screen orientation (degrees): the orientation the
 * BAKED PIXELS carry (each bake moves the layer's field rotation into
 * pixels and zeroes the field — reconstructed as origin rotation +
 * accRotation whenever the exchange no longer sits on its source asset)
 * plus the live field rotation still un-baked on the layer. Snapping,
 * HUD anchoring and feedback chips all read THIS — against the zeroed
 * field alone, a rotated fragment could never return to upright.
 * Legacy records without an origin fall back to the field rotation alone
 * (pre-session behavior).
 */
export function fragmentTrueRotationDeg(
  session: PeelSession,
  exchange: Pick<Layer, 'assetId' | 'rotation'>,
): number {
  const bakedAtLeastOnce =
    !!session.origin && session.origin.layer.assetId !== exchange.assetId;
  const carriedRotationDeg = bakedAtLeastOnce
    ? (session.origin?.layer.rotation ?? 0) + (session.accRotation ?? 0)
    : 0;
  return carriedRotationDeg + exchange.rotation;
}
