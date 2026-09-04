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
    cursorOverride: null,
    hud: null,
    smartguides: null,
    selectionErrorPulse: 0,
  },
  // [P2 Perf] Buffer version counter for snapshot cache invalidation
  _bufferVersion: 0,
};

/**
 * useVolatileState: Fast-track state management core (producer)
 *
 * The single owner of `volatileRef`. Exposes the lowest-level atomic
 * mutate / update / commit / reset handles. All higher-level fast-track
 * behaviour (facade, merge, consumers) is layered on top of this ref.
 */
export function useVolatileState(): VolatileStateHandle {
  const volatileRef = useRef<VolatileState>({ ...INITIAL_VOLATILE });

  const mutate = useCallback((mutator: (v: VolatileState) => void) => {
    mutator(volatileRef.current);
    volatileRef.current.activeState.interacting = true;
  }, []);

  const update = useCallback((patch: Partial<VolatileState>) => {
    Object.assign(volatileRef.current, patch);
    volatileRef.current.activeState.interacting = true;
  }, []);

  const commit = useCallback(() => {
    volatileRef.current.activeState.interacting = false;
  }, []);

  const reset = useCallback(() => {
    // Reset to initial values using in-place update
    volatileRef.current.activeState.interacting = false;
    volatileRef.current.buffered = { layers: {}, frames: {}, project: {} };
    volatileRef.current.transient = {};
  }, []);

  return { volatileRef, mutate, update, commit, reset };
}
