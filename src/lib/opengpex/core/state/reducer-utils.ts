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

import { Frame, EditorData, NormalizedState, Layer } from '@opengpex/editor/core/types';

export interface EditorReconcileSubset {
  frames: NormalizedState<Frame>;
  activeFrameId: string | null;
}

/**
 * reconcileDeep: General deep value reconciler (Immer-friendly)
 * Compares source and target objects, and modifies the draft in-place as much as possible to maintain reference consistency, avoiding unnecessary Immer Patches.
 */
function reconcileDeep(draftVal: unknown, sourceVal: unknown): unknown {
  // 1. If either is a primitive type, directly return the source data value (Immer will determine if it actually changed)
  if (typeof sourceVal !== 'object' || sourceVal === null || typeof draftVal !== 'object' || draftVal === null) {
    return sourceVal;
  }

  // 2. If it is an array
  if (Array.isArray(sourceVal)) {
    const draftArr = draftVal as unknown[];
    if (!Array.isArray(draftVal) || draftArr.length !== sourceVal.length) {
      return [...sourceVal];
    }
    for (let i = 0; i < sourceVal.length; i++) {
      draftArr[i] = reconcileDeep(draftArr[i], sourceVal[i]);
    }
    return draftArr;
  }

  // 3. If it is a plain object
  const draftObj = draftVal as Record<string | symbol, unknown>;
  const sourceObj = sourceVal as Record<string | symbol, unknown>;
  const draftKeys = Reflect.ownKeys(draftObj);
  const sourceKeys = Reflect.ownKeys(sourceObj);
  const allKeys = new Set([...draftKeys, ...sourceKeys]);

  allKeys.forEach(key => {
    // If the property is not in source, remove it from the draft
    if (!(key in sourceObj)) {
      delete draftObj[key];
      return;
    }

    // If the property is not in draft, assign it directly
    if (!(key in draftObj)) {
      draftObj[key] = sourceObj[key];
      return;
    }

    // Both sides have it, perform deep recursive reconciliation
    draftObj[key] = reconcileDeep(draftObj[key], sourceObj[key]);
  });

  return draftObj;
}

/**
 * Reconciler: Uses strict difference determination to reconcile the source state to the draft object.
 * Ensures that Immer generates fine-grained, noise-free Patches, while maximizing reference consistency (===) for unaffected artboards.
 */
export function reconcileEditorState(draft: EditorReconcileSubset, source: EditorReconcileSubset): void {
  // 1. Reconcile artboard order
  if (draft.frames.order.join(',') !== source.frames.order.join(',')) {
    draft.frames.order = [...source.frames.order];
  }

  // 2. Remove deleted artboards
  Object.keys(draft.frames.byId).forEach(key => {
    if (!source.frames.byId[key]) {
      delete draft.frames.byId[key];
    }
  });

  // 3. Reconcile artboard properties one by one
  source.frames.order.forEach(id => {
    const f = source.frames.byId[id];
    if (!draft.frames.byId[id]) {
      draft.frames.byId[id] = f;
    } else {
      const df = draft.frames.byId[id] as unknown as Record<string, unknown>;
      const fAny = f as unknown as Record<string, unknown>;

      // Ensure canvas is always explicitly preserved to prevent accidental Immer "remove" patches
      if (fAny.canvas) {
        const dfCanvas = df.canvas as { w: number; h: number } | undefined;
        const fAnyCanvas = fAny.canvas as { w: number; h: number };
        if (!dfCanvas || dfCanvas.w !== fAnyCanvas.w || dfCanvas.h !== fAnyCanvas.h) {
          df.canvas = { ...fAnyCanvas };
        }
      }

      const allKeys = new Set([...Reflect.ownKeys(df), ...Reflect.ownKeys(fAny)]);
      allKeys.forEach(key => {
        // [Architecture Design: Time machine exclusion and bypass rules]
        // - camera: Must be excluded! Because viewport camera adjustment is an asynchronous fine-tuning operation in the UI layer, and does not represent a change in the physical state of the document.
        //   If not excluded, the automatic Camera Fit when opening a new drawing will pollute the undo stack, causing ghost steps that require cmd+z to be pressed twice to undo.
        // - latestClipTool: Must be excluded! Tool switching (Tab/Shift+Tab) is a UI navigation action, not a document edit.
        //   Without this exclusion, cycling tools (rect→ellipse→lasso) creates undo steps, and Cmd+Z reverts the tool selection — completely unexpected.
        // - activeLayerId: Must be allowed! Because when actual layer additions, deletions, or modifications occur, we need the focus selection state to naturally bounce back during undo.
        //   Moreover, clicking the layer list alone only dispatches SET_ACTIVE_LAYER and does not trigger SIGNAL_COMMIT, so it will never generate ghost steps.
        if (key === 'canvas' || key === 'camera' || key === 'latestClipTool') return; // Excluded from history tracking

        if (key === 'layers') {
          // Deep reconcile layers NormalizedState
          const dfLayers = df.layers as unknown as NormalizedState<Layer>;
          const fAnyLayers = fAny.layers as unknown as NormalizedState<Layer>;

          if (dfLayers.order.join(',') !== fAnyLayers.order.join(',')) {
            dfLayers.order = [...fAnyLayers.order];
          }
          Object.keys(dfLayers.byId).forEach(lId => {
            if (!fAnyLayers.byId[lId]) {
              delete dfLayers.byId[lId];
            }
          });
          fAnyLayers.order.forEach((lId: string) => {
            const l = fAnyLayers.byId[lId];
            if (!dfLayers.byId[lId]) {
              dfLayers.byId[lId] = l;
            } else {
              const dl = dfLayers.byId[lId] as unknown as Record<string, unknown>;
              const lAny = l as unknown as Record<string, unknown>;
              const allLayerKeys = new Set([...Reflect.ownKeys(dl), ...Reflect.ownKeys(lAny)]);
              allLayerKeys.forEach(lk => {
                dl[lk as string] = reconcileDeep(dl[lk as string], lAny[lk as string]);
              });
              Reflect.ownKeys(dl).forEach(lk => {
                if (!(lk in lAny)) {
                  delete dl[lk as string];
                }
              });
            }
          });
          return;
        }

        // 🌟 General adaptive deep reconciliation (automatically handles any nested objects/arrays, including imageCropBox, thumbnail, adjustments, flip, etc.)
        df[key as string] = reconcileDeep(df[key as string], fAny[key as string]);
      });

      Reflect.ownKeys(df).forEach(key => {
        // canvas, layers, camera need to be implicitly protected and must never be implicitly removed from draft just because they are not declared in the source properties.
        if (key === 'canvas' || key === 'layers' || key === 'camera') return; // NEVER delete implicitly
        if (!(key in fAny)) {
          delete df[key as string];
        }
      });
    }
  });

  // 4. Reconcile currently active artboard ID (removed: UI selection state should not pollute undo history)
}

/**
 * Merges the live camera state of the current editor into the frames list to be restored
 * 
 * [Architecture Fix] When the canvas size changes (such as rotation undo/redo), camera offset needs to be recomputed
 * based on the size difference to keep the visual center point unchanged, rather than directly using the incorrect camera left in the restored state.
 * 
 * Camera model: Screen coordinates of canvas center = (cam.x + canvas.w/2 * cam.k, cam.y + canvas.h/2 * cam.k)
 * Keep center unchanged: newCam.x + restored.w/2 * k = liveCam.x + live.w/2 * k
 *             → newCam.x = liveCam.x + (live.w - restored.w) / 2 * k
 */
export function mergeLiveCameras(restoredFrames: NormalizedState<Frame>, currentState: EditorData): NormalizedState<Frame> {
  const nextById: Record<string, Frame> = {};
  restoredFrames.order.forEach(id => {
    const restored = restoredFrames.byId[id];
    const live = currentState.frames.byId[id];
    if (live && live.canvas.w === restored.canvas.w && live.canvas.h === restored.canvas.h) {
      // Canvas size unchanged: directly use live camera, keeping the user's current viewpoint
      nextById[id] = {
        ...restored,
        camera: { ...live.camera }
      };
    } else if (live) {
      // Canvas size changed (rotation undo/redo): recalculate offset based on live camera to maintain visual center
      // Principle: Screen coordinates of canvas center in camera model = (cam.x + canvas.w/2 * k, cam.y + canvas.h/2 * k)
      // To keep center unchanged, compensate for size difference: newX = liveX + (liveW - restoredW)/2 * k
      // This is exactly the inverse operation of the rotation compensation formula in transformFrame
      const cam = live.camera;
      const dw = live.canvas.w - restored.canvas.w;
      const dh = live.canvas.h - restored.canvas.h;
      const nextCamera = {
        x: cam.x + dw / 2 * cam.k,
        y: cam.y + dh / 2 * cam.k,
        k: cam.k
      };
      console.debug(
        '[mergeLiveCameras] Canvas dimension changed during undo/redo, recalculating camera to preserve center.',
        `frameId=${id}`,
        `live.canvas=${live.canvas.w}×${live.canvas.h}`,
        `restored.canvas=${restored.canvas.w}×${restored.canvas.h}`,
        `liveCam=(${cam.x.toFixed(1)}, ${cam.y.toFixed(1)}, k=${cam.k.toFixed(3)})`,
        `→ newCam=(${nextCamera.x.toFixed(1)}, ${nextCamera.y.toFixed(1)}, k=${nextCamera.k.toFixed(3)})`
      );
      nextById[id] = {
        ...restored,
        camera: nextCamera
      };
    } else {
      nextById[id] = restored;
    }
  });
  return { byId: nextById, order: restoredFrames.order };
}

/**
 * Per-frame reconciler: Reconciles a single frame's state for Immer patch generation.
 * Same exclusion rules as reconcileEditorState (camera excluded, layers deep-reconciled).
 * Called inside `produceWithPatches(checkpoint, draft => reconcileFrameState(draft, currentFrame))`.
 */
export function reconcileFrameState(draft: Frame, source: Frame): void {
  const df = draft as unknown as Record<string, unknown>;
  const fAny = source as unknown as Record<string, unknown>;

  // Ensure canvas is always explicitly preserved
  if (fAny.canvas) {
    const dfCanvas = df.canvas as { w: number; h: number } | undefined;
    const fAnyCanvas = fAny.canvas as { w: number; h: number };
    if (!dfCanvas || dfCanvas.w !== fAnyCanvas.w || dfCanvas.h !== fAnyCanvas.h) {
      df.canvas = { ...fAnyCanvas };
    }
  }

  const allKeys = new Set([...Reflect.ownKeys(df), ...Reflect.ownKeys(fAny)]);
  allKeys.forEach(key => {
    // Same exclusion rules: camera and latestClipTool excluded from history tracking
    if (key === 'canvas' || key === 'camera' || key === 'latestClipTool') return;

    if (key === 'layers') {
      // Deep reconcile layers NormalizedState
      const dfLayers = df.layers as unknown as NormalizedState<Layer>;
      const fAnyLayers = fAny.layers as unknown as NormalizedState<Layer>;

      if (dfLayers.order.join(',') !== fAnyLayers.order.join(',')) {
        dfLayers.order = [...fAnyLayers.order];
      }
      Object.keys(dfLayers.byId).forEach(lId => {
        if (!fAnyLayers.byId[lId]) {
          delete dfLayers.byId[lId];
        }
      });
      fAnyLayers.order.forEach((lId: string) => {
        const l = fAnyLayers.byId[lId];
        if (!dfLayers.byId[lId]) {
          dfLayers.byId[lId] = l;
        } else {
          const dl = dfLayers.byId[lId] as unknown as Record<string, unknown>;
          const lAny = l as unknown as Record<string, unknown>;
          const allLayerKeys = new Set([...Reflect.ownKeys(dl), ...Reflect.ownKeys(lAny)]);
          allLayerKeys.forEach(lk => {
            dl[lk as string] = reconcileDeep(dl[lk as string], lAny[lk as string]);
          });
          Reflect.ownKeys(dl).forEach(lk => {
            if (!(lk in lAny)) {
              delete dl[lk as string];
            }
          });
        }
      });
      return;
    }

    // General adaptive deep reconciliation
    df[key as string] = reconcileDeep(df[key as string], fAny[key as string]);
  });

  Reflect.ownKeys(df).forEach(key => {
    if (key === 'canvas' || key === 'layers' || key === 'camera') return;
    if (!(key in fAny)) {
      delete df[key as string];
    }
  });
}

/**
 * Merge live camera into a single restored frame.
 * Used by per-frame UNDO/REDO to preserve the user's current viewpoint.
 */
export function mergeLiveCameraForFrame(restoredFrame: Frame, liveFrame: Frame | undefined): Frame {
  if (!liveFrame) return restoredFrame;
  if (liveFrame.canvas.w === restoredFrame.canvas.w && liveFrame.canvas.h === restoredFrame.canvas.h) {
    return { ...restoredFrame, camera: { ...liveFrame.camera } };
  }
  // Canvas size changed: recalculate camera offset to preserve visual center
  const cam = liveFrame.camera;
  const dw = liveFrame.canvas.w - restoredFrame.canvas.w;
  const dh = liveFrame.canvas.h - restoredFrame.canvas.h;
  return {
    ...restoredFrame,
    camera: {
      x: cam.x + dw / 2 * cam.k,
      y: cam.y + dh / 2 * cam.k,
      k: cam.k
    }
  };
}
