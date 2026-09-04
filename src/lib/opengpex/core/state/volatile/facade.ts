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

import { RefObject } from 'react';
import {
  VolatileState, EditorData, EditorAction, Layer, Frame, CameraState,
} from '@opengpex/editor/core/types';
import { getCompositeKey, mergeLayerDraft } from './merge';

/**
 * Dependencies injected into the fast-track facade factory.
 *
 * Everything the facade needs is passed in explicitly so the facade itself is a
 * pure factory with no direct dependency on `useEditorStore` internals.
 */
export interface FastFacadeDeps {
  /** The owned volatile fast-track ref (from useVolatileState). */
  volatileRef: RefObject<VolatileState>;
  /** Live ref to the latest reducer state. */
  stateRef: RefObject<EditorData>;
  /** Atomic volatile mutate handle (marks interacting=true). */
  mutateVolatile: (mutator: (v: VolatileState) => void) => void;
  /** Atomic volatile reset handle. */
  resetVolatile: () => void;
  /** Enhanced reducer dispatch. */
  dispatch: (action: EditorAction) => void;
  /** Volatile Interaction per-field listener notifier. */
  notify: (key: string) => void;
  /** Volatile Interaction per-field listener map ref (for subscribeInteraction). */
  listenersRef: RefObject<Map<string, Set<() => void>>>;
}

/**
 * createFastFacade: builds the `actions.fast.*` command-imperative API.
 *
 * This is the Facade layer of the Volatile fast-track:
 *   - write overrides (`override`), commit to Redux (`commit`), transaction signal (`signal`)
 *   - read fused "latest" values (`latestLayer` / `latestFrame` / `latestCamera`)
 *   - read/write high-frequency interaction fields (`setHover` / `setCursor` / ...)
 *
 * Behaviour is identical to the previous inline `fast: { ... }` object in
 * `useEditorStore`; this is a pure code-organization extraction.
 */
export function createFastFacade(deps: FastFacadeDeps) {
  const { volatileRef, stateRef, mutateVolatile, resetVolatile, dispatch, notify, listenersRef } = deps;

  return {
    latestLayer: (frameId: string, id: string): Layer | null => {
      const v = volatileRef.current;
      const frame = stateRef.current.frames.byId[frameId];
      const layer = frame?.layers.byId[id];
      if (!layer) return null;

      const compositeKey = getCompositeKey(frameId, id);
      const draft = v.buffered.layers[compositeKey];
      return (v.activeState.interacting && draft) ? mergeLayerDraft(layer, draft) : layer;
    },
    latestFrame: (id: string): Frame | null => {
      const v = volatileRef.current;
      const frame = stateRef.current.frames.byId[id];
      if (!frame) return null;
      const draft = v.buffered.frames[id];
      return (v.activeState.interacting && draft) ? { ...frame, ...draft } : frame;
    },
    latestCamera: (id: string): CameraState => {
      const v = volatileRef.current;
      const frame = stateRef.current.frames.byId[id];
      if (!frame) return { x: 0, y: 0, k: 1 };
      // [Fix] Do not gate on interacting flag.
      // fast.commit() sets interacting=false synchronously but dispatches UPDATE_FRAME via rAF.
      // In the window between commit and rAF execution, interacting=false but frame.camera is
      // still the old Redux value. If a new session starts in this window, latestCamera would
      // return the stale frame.camera as the baseline, causing the new session's camera
      // calculations to start from the wrong position — producing the visible "snap-back".
      // Fix: always prefer buffered.camera if it exists, regardless of interacting state.
      const bufferedCamera = v.buffered.frames[id]?.camera;
      return bufferedCamera ?? frame.camera;
    },
    isInteracting: () => volatileRef.current.activeState.interacting,
    getTransient: (key: string) => volatileRef.current.transient[key],
    setTransient: (key: string, data: unknown) => mutateVolatile(v => { v.transient[key] = data as Record<string, unknown>; }),
    override: (frameId: string, id: string, props: Record<string, unknown>, type: 'layer' | 'frame' | 'project' = 'layer') => {
      mutateVolatile(v => {
        if (type === 'layer') {
          const compositeKey = getCompositeKey(frameId, id);
          v.buffered.layers[compositeKey] = { ...v.buffered.layers[compositeKey], ...props };
          v._bufferVersion++; // [P2 Perf] Invalidate snapshot cache
        } else if (type === 'frame') {
          v.buffered.frames[id] = { ...v.buffered.frames[id], ...props };
          v._bufferVersion++; // [P2 Perf] Invalidate snapshot cache
        } else {
          v.buffered.project = { ...v.buffered.project, ...props };
        }
      });
    },

    commit: (id?: string | null, type: 'layer' | 'layers' | 'frame' | 'frames' | 'project' = 'layer') => {
      const v = volatileRef.current;
      if (type === 'layers') {
        // Group patches of composite keys (frameId:layerId) by frame for submission
        const frameGroups: Record<string, Record<string, Partial<Layer>>> = {};

        Object.entries(v.buffered.layers).forEach(([compositeKey, patch]) => {
          const [fId, lId] = compositeKey.split(':');
          if (!frameGroups[fId]) frameGroups[fId] = {};
          // Filter out non-serialized imageOverride and bitmapMaskOverride properties to prevent them from entering the Redux Store
          const { imageOverride: _io1, bitmapMaskOverride: _bm1, ...serializablePatch } = patch;
          if (Object.keys(serializablePatch).length > 0) {
            frameGroups[fId][lId] = serializablePatch;
          }
        });

        Object.entries(frameGroups).forEach(([fId, patches]) => {
          if (Object.keys(patches).length > 0) {
            dispatch({ type: 'BATCH_UPDATE_LAYER', payload: { frameId: fId, patches } });
          }
        });
      } else if (type === 'frames') {
        const patches = { ...v.buffered.frames };
        if (Object.keys(patches).length > 0) dispatch({ type: 'BATCH_UPDATE_FRAME', payload: { patches } });
      } else if (type === 'layer' || type === 'frame') {
        if (!id) return;

        if (type === 'layer') {
          // Note: When submitting a single layer, we need to find which frame it belongs to
          // Simplified handling here: find the first composite key matching the layerId
          const compositeEntry = Object.entries(v.buffered.layers).find(([key]) => key.endsWith(`:${id}`));
          if (compositeEntry) {
            const [fId] = compositeEntry[0].split(':');
            // Filter out non-serialized imageOverride and bitmapMaskOverride properties to prevent them from entering the Redux Store
            const { imageOverride: _io2, bitmapMaskOverride: _bm2, ...serializablePatch } = compositeEntry[1];
            if (Object.keys(serializablePatch).length > 0) {
              dispatch({ type: 'UPDATE_LAYER', payload: { frameId: fId, layerId: id, patch: serializablePatch } });
            }
          }
        } else {
          const patch = v.buffered.frames[id];
          if (patch) dispatch({ type: 'UPDATE_FRAME', payload: { id, patch } });
        }
      }
      // [Critical Fix] Delay clearing buffered to prevent fast-track/slow-track tearing.
      // dispatch is asynchronous (React batches it), but delete is synchronous.
      // If cleared synchronously, the Ticker might read an empty draft + old State before React updates -> flash.
      // Delay clearing by one frame to ensure React has consumed the draft before removal.
      volatileRef.current.activeState.interacting = false;
      requestAnimationFrame(() => {
        const vRef = volatileRef.current;
        if (type === 'layers') vRef.buffered.layers = {};
        else if (type === 'frames') vRef.buffered.frames = {};
        else if (type === 'project') vRef.buffered.project = {};
        else if (id) {
          if (type === 'layer') {
            const keys = Object.keys(vRef.buffered.layers).filter(k => k.endsWith(`:${id}`));
            keys.forEach(k => delete vRef.buffered.layers[k]);
          }
          else if (type === 'frame') delete vRef.buffered.frames[id];
        }
        // 💡 After the interaction is completely committed, clear transient reference data like alignment guides to prevent erroneous activation during two-finger panning
        if (vRef.transient.smartguides !== undefined) {
          delete vRef.transient.smartguides;
        }
      });
    },
    signal: (frameId: string) => {
      mutateVolatile(v => { v.activeState.interacting = true; });
      dispatch({ type: 'SIGNAL_COMMIT', payload: { frameId } });
    },
    reset: resetVolatile,

    // ─── Volatile Interaction (high-frequency transient state) ─────────
    setCursor: (cursor: string | null) => {
      const vi = volatileRef.current.interaction;
      if (vi.cursorOverride === cursor) return;
      vi.cursorOverride = cursor;
      notify('cursorOverride');
    },
    getCursor: () => volatileRef.current.interaction.cursorOverride,
    setHover: (layerId: string | null, isHoveringActive = false) => {
      const vi = volatileRef.current.interaction;
      const hoverChanged = vi.hoveredLayerId !== layerId;
      const activeChanged = vi.isHoveringActiveLayer !== isHoveringActive;
      if (!hoverChanged && !activeChanged) return;
      if (hoverChanged) { vi.hoveredLayerId = layerId; notify('hoveredLayerId'); }
      if (activeChanged) { vi.isHoveringActiveLayer = isHoveringActive; notify('isHoveringActiveLayer'); }
    },
    subscribeInteraction: (key: string, listener: () => void) => {
      const map = listenersRef.current;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(listener);
      return () => { map.get(key)?.delete(listener); };
    },
  };
}

