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
 * peel/inflight.ts — the module-level registration a fragment transform
 * gesture holds open for the duration of ONE pointer drag, so a settle
 * arriving MID-GESTURE (Space / Enter while the pointer is still down) can
 * bake the in-flight pose before promoting the session.
 *
 * Layer separation (why this is NOT part of the session record in
 * ./session.ts): the session record is a DOCUMENT fact (undo ledger,
 * persistence, hydrate); this slot is a PROCESS-LOCAL transient — it lives
 * only while a pointer drag is live, never reaches the store, and dies at
 * pointer-up or settle consumption. At most one transform gesture can be
 * live (gestures are exclusive), so a single slot — not a map — is the
 * honest shape. Both writers and readers are the peel family itself (the
 * session transform handler registers, the settle command consumes), so
 * the slot lives beside the commands by ownership, not by dependency
 * direction.
 */

import type { TransformParams } from '@opengpex/editor/core/types';

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
