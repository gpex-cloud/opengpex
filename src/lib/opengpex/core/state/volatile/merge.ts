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

import { VolatileState, Frame, CameraState, Layer } from '@opengpex/editor/core/types';
import { LayerUtils } from '@opengpex/editor/core/layer/utils';

/**
 * merge.ts — the single source of truth (SSOT) for the Volatile fast-track's
 * "volatile draft + React state → latest" fusion.
 *
 * Both the imperative facade (`actions.fast.latest*`) and the declarative
 * per-frame consumer (`useFastSync` snapshot branch) fuse volatile drafts with
 * reducer state. Historically each wrote its own copy of that fusion math; this
 * module collapses the *computation* into one place so tearing / snap-back fixes
 * only need to be maintained once.
 *
 * ── Gating policy (interacting flag) ──────────────────────────────────────────
 * The canonical rule, established while fixing camera snap-back and overlay
 * tearing, is: **do NOT treat `activeState.interacting` as the sole gate.**
 * `fast.commit()` flips `interacting = false` synchronously, but the matching
 * Redux dispatch lands asynchronously (rAF / React batching). During that window
 * the buffered draft is still the freshest truth, so merging must continue as
 * long as a draft exists (see `mergeCamera` and `mergeFrameSnapshot`).
 *
 * The imperative `latestLayer` / `latestFrame` readers intentionally still gate
 * on `interacting` at their call sites (they are queried by command handlers, a
 * different consumption pattern than the per-frame overlay path). Those call
 * sites decide *whether* to merge; the functions here own *how* to merge.
 */

/** Re-export the composite-key builder — the flat fast-track cache key basis. */
export const getCompositeKey = LayerUtils.getCompositeKey;

/** Re-export the layer draft merge — shallow overlay of a partial draft onto a layer. */
export const mergeLayerDraft = LayerUtils.mergeLayerDraft;

/**
 * mergeFrameDraft: shallow-overlay a buffered frame draft onto a state frame.
 * Pure computation; callers decide whether a draft should be applied.
 */
export function mergeFrameDraft(frame: Frame, draft?: Partial<Frame>): Frame {
  if (!draft) return frame;
  return { ...frame, ...draft };
}

/**
 * mergeCamera: resolve the freshest camera for a frame.
 *
 * Follows the canonical "don't gate on interacting" policy: prefer the buffered
 * camera draft whenever it exists, otherwise fall back to the state camera.
 */
export function mergeCamera(frame: Frame, draft?: Partial<Frame>): CameraState {
  return draft?.camera ? draft.camera : frame.camera;
}

/**
 * mergeFrameSnapshot: the per-tick fusion used by `useFastSync`.
 *
 * Merges the active frame's buffered frame draft + all buffered layer drafts
 * into a single "latest" frame, and resolves the latest camera. This is the
 * exact logic that used to live inline in `useFastSync`'s snapshot cache-miss
 * branch, extracted verbatim so the snapshot cache and the facade share one
 * fusion implementation.
 *
 * Note: this deliberately does NOT gate on `interacting` — see the module-level
 * gating policy. As long as drafts exist in the buffer they are merged, which is
 * what prevents the commit→dispatch window from flashing back to stale state.
 */
export function mergeFrameSnapshot(v: VolatileState, frame: Frame): { frame: Frame; cam: CameraState } {
  const frameDraft = v.buffered.frames[frame.id];

  // [Critical Fix] Do not use isInteracting as the sole guard.
  // isInteracting is synchronously set to false after commit, but React State updates asynchronously.
  // If we skip merging now, it will flash back to the old frame data (tearing).
  // Correct approach: as long as there are drafts in the buffer, continue to merge until React consumes them.
  let latestFrame = frame;
  const hasLayerDrafts = Object.keys(v.buffered.layers).length > 0;
  if (frameDraft || hasLayerDrafts) {
    latestFrame = { ...frame, ...frameDraft };
    // Deep stitching: merge fast-track layer increments into the layers array
    if (hasLayerDrafts) {
      const nextById: Record<string, Layer> = {};
      for (const id of frame.layers.order) {
        nextById[id] = mergeLayerDraft(frame.layers.byId[id], v.buffered.layers[getCompositeKey(frame.id, id)]);
      }
      latestFrame.layers = { byId: nextById, order: frame.layers.order };
    }
  }

  // Merge camera (fast-track first: use draft as long as it exists)
  const latestCam = mergeCamera(frame, frameDraft);

  return { frame: latestFrame, cam: latestCam };
}
