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

import { useCallback, useRef } from 'react';
import { VolatileState, VolatileStateHandle } from '@opengpex/editor/core/types';

/**
 * Fast-track initial state
 */
export const INITIAL_VOLATILE: VolatileState = {
  activeState: {
    interacting: false,
  },
  buffered: {
    layers: {},
    frames: {},
    project: {},
  },
  transient: {},
  interaction: {
    hoveredLayerId: null,
    isHoveringActiveLayer: false,
    resolvedCursor: null,
    globalCursor: null,
    /** Per-channel spring key engagement (see VolatileInteraction). */
    springChannels: { meta: false, alt: false, shift: false },
    /** Spring key suppression (modal contexts that own every press). */
    springSuppressed: false,
    hud: null,
    smartguides: null,
  },
  // [Perf] Buffer version counter for snapshot cache invalidation
  _bufferVersion: 0,
};

/**
 * useVolatileState: Fast-track state management core (producer)
 *
 * The single owner of `volatileRef`. Exposes the lowest-level atomic
 * mutate / update / commit / reset handles. All higher-level fast-track
 * behaviour (facade, merge, consumers) is layered on top of this ref.
 *
 * Snapshot invalidation contract: the per-tick merge snapshot (useFastSync)
 * is keyed on `_bufferVersion` plus the committed frame reference. Every
 * primitive here that can change `buffered` bumps the version itself, so a
 * buffered change can never be served stale by the snapshot — the writer
 * has no invalidation duty. Before this lived in the primitives, each writer
 * bumped by hand; the ones that forgot (an editing session's draft writes
 * once the session stopped dispatching to the slow track) froze the GPU
 * composite at a pre-write state while the DOM moved on. The `transient`
 * domain does NOT go through these primitives (see the facade's setTransient):
 * it never enters the merge, and bumping on its pointermove-rate writes
 * would defeat the snapshot cache.
 */
export function useVolatileState(): VolatileStateHandle {
  const volatileRef = useRef<VolatileState>({ ...INITIAL_VOLATILE });

  const mutate = useCallback((mutator: (v: VolatileState) => void) => {
    mutator(volatileRef.current);
    volatileRef.current.activeState.interacting = true;
    volatileRef.current._bufferVersion++;
  }, []);

  const update = useCallback((patch: Partial<VolatileState>) => {
    Object.assign(volatileRef.current, patch);
    volatileRef.current.activeState.interacting = true;
    volatileRef.current._bufferVersion++;
  }, []);

  const commit = useCallback(() => {
    volatileRef.current.activeState.interacting = false;
  }, []);

  const reset = useCallback(() => {
    // Reset to initial values using in-place update
    volatileRef.current.activeState.interacting = false;
    volatileRef.current.buffered = { layers: {}, frames: {}, project: {} };
    volatileRef.current.transient = {};
    // The buffer was replaced wholesale: the merge snapshot must not keep
    // serving drafts that no longer exist.
    volatileRef.current._bufferVersion++;
  }, []);

  // Flag-neutral cleanup: mutate the buffer WITHOUT touching `interacting`.
  // Used for GC-style removal of shadow buffers (REMOVE_FRAME / REMOVE_LAYERS),
  // which is not a user interaction. Using `mutate` there wrongly set
  // interacting=true and — with no following commit — left it stuck true after
  // REMOVE_FRAME, polluting fast-track throttle / merge gating / idle checks.
  // Flag-neutral is about `interacting` only: a deleted draft is still a
  // buffered change, so the snapshot version bumps like every other write.
  const cleanup = useCallback((mutator: (v: VolatileState) => void) => {
    mutator(volatileRef.current);
    volatileRef.current._bufferVersion++;
  }, []);

  return { volatileRef, mutate, update, commit, reset, cleanup };
}
