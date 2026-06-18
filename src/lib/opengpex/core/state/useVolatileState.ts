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

import { useEffect, useCallback, useRef } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import { Motion, MotionVars } from '@opengpex/editor/core/motion';
import { VolatileState, VolatileStateHandle, CameraState } from '@opengpex/editor/core/types';
import { LayerUtils } from '@opengpex/editor/core/layer/LayerUtils';

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
};

/**
 * useVolatileState: Fast-track state management core (producer)
 * Responsible for defining data sources and atomic operation handles
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

/**
 * useFastSync: Physical clock synchronization hook
 * @param targetRef Target DOM reference
 * @param mapper Mapping function that returns tween properties based on Volatile state
 */
export function useFastSync(
  targetRef: React.RefObject<HTMLElement | null>,
  mapper: (v: VolatileState) => MotionVars | null
) {
  const { volatileRef } = useEditorServices();

  useEffect(() => {
    const onTick = () => {
      const v = volatileRef.current;
      if (!v.activeState.interacting || !targetRef.current) return;

      const vars = mapper(v);
      if (vars) {
        Motion.set(targetRef.current, vars);
      }
    };

    Motion.ticker.add(onTick);
    return () => Motion.ticker.remove(onTick);
  }, [volatileRef, targetRef, mapper]);
}

/**
 * useVolatileUpdate: Interaction acceleration update helper
 */
export function useVolatileUpdate() {
  const { volatileRef, actions } = useEditorServices();

  return { 
    update: actions.updateVolatile, 
    mutate: actions.mutateVolatile, 
    commit: actions.commitVolatile, 
    reset: actions.resetVolatile, 
    volatileRef 
  };
}

/**
 * useVolatileValue: Utility logic to prioritize retrieving values from the fast-track (without triggering React redraw)
 */
export function useVolatileValue() {
  const { volatileRef } = useEditorServices();

  const getLayerTransform = (frameId: string, layer: { id: string; cx: number; cy: number; rotation: number }) => {
    const v = volatileRef.current;
    const compositeKey = LayerUtils.getCompositeKey(frameId, layer.id);
    const draft = v.buffered.layers[compositeKey];

    return {
      cx: draft?.cx ?? layer.cx,
      cy: draft?.cy ?? layer.cy,
      rotation: draft?.rotation ?? layer.rotation,
    };
  };

  const getCamera = (stateCamera: CameraState) => {
    const v = volatileRef.current;
    // Automatically look for the first camera override in the buffer, and fall back if none
    const bufferedCamera = Object.values(v.buffered.frames)[0]?.camera;
    return (v.activeState.interacting && bufferedCamera) ? bufferedCamera : stateCamera;
  };

  return { getLayerTransform, getCamera, volatileRef };
}

/**
 * useThrottledSync: Low-frequency synchronization helper
 * Used to synchronize state to React State at a lower frequency (e.g., 50ms) during interaction, reducing rendering pressure.
 */
export function useThrottledSync() {
  const lastTimeRef = useRef(0);

  const throttle = useCallback((callback: () => void, ms: number = 50) => {
    const now = Date.now();
    if (now - lastTimeRef.current > ms) {
      callback();
      lastTimeRef.current = now;
    }
  }, []);

  return throttle;
}
