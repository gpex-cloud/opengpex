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

import { EditorData, EditorAction, Frame, Layer, FrameHistoryState, GlobalHistoryState } from '@opengpex/editor/core/types';
import { produceWithPatches, enablePatches, applyPatches, Patch } from 'immer';
import { reconcileFrameState, mergeLiveCameraForFrame } from './reducer-utils';

enablePatches();

/** Maximum undo steps per frame */
const MAX_HISTORY_STEPS = 50;

export const initialState: EditorData = {
  frames: { byId: {}, order: [] },
  activeFrameId: null,
  pluginConfig: {},
  ui: {
    viewportDim: { w: 0, h: 0 },

    theme: {
      active: 'DEFAULT',
      config: {
        // [REFACTOR-Step3] Seed insets with the default chrome geometry
        // (HEADER 48 + DRAWER_BAR 40 on both sides) so command-side consumers
        // (fit / actualSize / zoomBy) compute correct centering during the
        // very first render — before LayoutProvider reaches STABLE and
        insets: {
          top: 48,
          bottom: 0,
          fixed: { left: 40, right: 40 },
          varied: { left: 0, right: 0 }
        }
      }
    },
    appearance: 'system',
    activeSidebarIds: [],
    sidebarOrder: { left: [], right: [] },
    sidebarMode: 'FLOATING'
  },
  isLoaded: false,
  confirm: null,
  choice: null,
  interaction: {
    smartguides: null,
    interactionMode: 'pan',
    isInteracting: false,
    isSnapping: true,
    signals: {},
    cursorOverride: null,
  },
  history: {
    byFrameId: {}
  },
  runtime: {
    engineStatuses: []
  }
};


export function editorReducer(state: EditorData, action: EditorAction): EditorData {
  switch (action.type) {
    case 'SET_LOADED':
      return { ...state, isLoaded: action.payload };

    case 'ADD_FRAME': {
      const frame = action.payload.frame;
      const nextFrames = {
        byId: { ...state.frames.byId, [frame.id]: frame },
        order: [...state.frames.order, frame.id]
      };
      // System-level check: If this is the very first frame in the workspace, force it to be active regardless of switchFrame flag.
      const nextActiveFrameId = (action.payload.switchFrame || state.frames.order.length === 0) ? frame.id : state.activeFrameId;

      return {
        ...state,
        frames: nextFrames,
        activeFrameId: nextActiveFrameId,
        // New frame gets an empty history stack (natural undo floor)
        history: {
          byFrameId: {
            ...state.history.byFrameId,
            [frame.id]: { past: [], future: [], checkpoint: null }
          }
        }
      };
    }

    case 'SWITCH_FRAME':
      return { ...state, activeFrameId: action.payload };

    case 'UPDATE_FRAME': {
      const { id, patch } = action.payload;
      const frame = state.frames.byId[id];
      if (!frame) return state;
      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [id]: { ...frame, ...patch }
          }
        }
      };
    }

    case 'BATCH_UPDATE_FRAME': {
      const { patches } = action.payload;
      const nextById = { ...state.frames.byId };
      Object.keys(patches).forEach(id => {
        if (nextById[id]) {
          nextById[id] = { ...nextById[id], ...patches[id] };
        }
      });
      return {
        ...state,
        frames: { ...state.frames, byId: nextById }
      };
    }

    case 'REMOVE_FRAME': {
      const { frameIds, nextActiveFrameId } = action.payload;
      const idsToRemove = new Set(frameIds);

      // 1. Pure state filtering
      const nextOrder = state.frames.order.filter(id => !idsToRemove.has(id));
      const nextById = { ...state.frames.byId };
      idsToRemove.forEach(id => delete nextById[id]);

      // 2. Per-frame history cleanup: simply remove deleted frames' history entries
      const nextByFrameId = { ...state.history.byFrameId };
      idsToRemove.forEach(id => delete nextByFrameId[id]);

      return {
        ...state,
        frames: { byId: nextById, order: nextOrder },
        activeFrameId: nextActiveFrameId,
        history: { byFrameId: nextByFrameId }
      };
    }


    case 'CLEAR_ALL_DATA': {
      return { ...state, frames: { byId: {}, order: [] }, activeFrameId: null, history: { byFrameId: {} } };
    }

    case 'REORDER_FRAMES': {
      const result = Array.from(state.frames.order);
      const [removed] = result.splice(action.payload.oldIndex, 1);
      result.splice(action.payload.newIndex, 0, removed);
      return { ...state, frames: { ...state.frames, order: result } };
    }

    case 'SET_FRAMES':
      return { ...state, frames: action.payload };

    case 'ADD_LAYER': {
      const { frameId, layers, index } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame) return state;

      const nextOrder = [...frame.layers.order];
      const nextById = { ...frame.layers.byId };
      const newIds = layers.map(l => {
        nextById[l.id] = l;
        return l.id;
      });

      if (typeof index === 'number') {
        nextOrder.splice(index, 0, ...newIds);
      } else {
        nextOrder.push(...newIds);
      }

      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: {
              ...frame,
              layers: { byId: nextById, order: nextOrder },
              activeLayerId: newIds[0] || frame.activeLayerId
            }
          }
        }
      };
    }

    case 'UPDATE_LAYER': {
      const { frameId, layerId, patch } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame || !frame.layers.byId[layerId]) return state;

      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: {
              ...frame,
              layers: {
                ...frame.layers,
                byId: {
                  ...frame.layers.byId,
                  [layerId]: { ...frame.layers.byId[layerId], ...patch }
                }
              }
            }
          }
        }
      };
    }

    case 'BATCH_UPDATE_LAYER': {
      const { frameId, patches } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame) return state;

      const nextById = { ...frame.layers.byId };
      Object.keys(patches).forEach(layerId => {
        if (nextById[layerId]) {
          nextById[layerId] = { ...nextById[layerId], ...patches[layerId] };
        }
      });

      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: {
              ...frame,
              layers: { ...frame.layers, byId: nextById }
            }
          }
        }
      };
    }

    case 'SET_ACTIVE_LAYER': {
      const { frameId, layerId } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame) return state;

      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: { ...frame, activeLayerId: layerId }
          }
        }
      };
    }

    case 'UPDATE_CAMERA': {
      const { frameId, camera } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame) return state;

      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: { ...frame, camera }
          }
        }
      };
    }

    case 'SET_CLIP_BOX': {
      const { frameId, toolId, value } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame) return state;

      let nextClipBoxes: Record<string, typeof value & {}>;
      if (value == null) {
        // Clear: remove the tool's slot. Idempotent — no-op when already absent.
        if (frame.clipBoxes[toolId] == null) return state;
        const { [toolId]: _omit, ...rest } = frame.clipBoxes;
        void _omit;
        nextClipBoxes = rest;
      } else {
        // Set: write the tool's slot.
        nextClipBoxes = { ...frame.clipBoxes, [toolId]: value };
      }

      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: { ...frame, clipBoxes: nextClipBoxes }
          }
        }
      };
    }

    case 'SET_CANVAS_CROP_BOX': {
      const { frameId, cropBox } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame) return state;
      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: { ...frame, canvasCropBox: cropBox }
          }
        }
      };
    }


    case 'SET_IMAGE_ASPECT': {
      const { frameId, aspect } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame) return state;
      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: { ...frame, imageAspect: aspect }
          }
        }
      };
    }

    case 'SET_CANVAS_ASPECT': {
      const { frameId, aspect } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame) return state;
      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: { ...frame, canvasAspect: aspect }
          }
        }
      };
    }

    case 'INIT_PLUGIN_CONFIG': {
      const { pluginId, initialConfig } = action.payload;
      return {
        ...state,
        pluginConfig: {
          ...state.pluginConfig,
          [pluginId]: {
            ...(initialConfig || {}),
            ...(state.pluginConfig[pluginId] || {})
          }
        }
      };
    }

    case 'UPDATE_PLUGIN_CONFIG':
      return {
        ...state,
        pluginConfig: {
          ...state.pluginConfig,
          [action.payload.pluginId]: {
            ...(state.pluginConfig[action.payload.pluginId] || {}),
            ...action.payload.patch
          }
        }
      };

    case 'REORDER_LAYERS': {
      const { frameId, oldIndex, newIndex } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame) return state;

      const nextOrder = Array.from(frame.layers.order);
      const [removed] = nextOrder.splice(oldIndex, 1);
      nextOrder.splice(newIndex, 0, removed);

      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: {
              ...frame,
              layers: { ...frame.layers, order: nextOrder }
            }
          }
        }
      };
    }

    case 'SET_LAYERS': {
      const { frameId, layers } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame) return state;

      const nextOrder = layers.map(l => l.id);
      const nextById: Record<string, Layer> = {};
      layers.forEach(l => (nextById[l.id] = l));

      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: {
              ...frame,
              layers: { byId: nextById, order: nextOrder }
            }
          }
        }
      };
    }

    case 'REMOVE_LAYERS': {
      const { frameId, layerIds, nextActiveLayerId } = action.payload;
      const frame = state.frames.byId[frameId];
      if (!frame) return state;

      const idsToRemove = new Set(layerIds);
      const nextOrder = frame.layers.order.filter(id => !idsToRemove.has(id));
      const nextById = { ...frame.layers.byId };
      idsToRemove.forEach(id => delete nextById[id]);

      let nextActiveId = nextActiveLayerId;
      // [Photoshop-style UX: Adjacent fallback activation protection mechanism for layer deletion]
      if (!nextActiveId && idsToRemove.has(frame.activeLayerId || '')) {
        const activeIndex = frame.layers.order.indexOf(frame.activeLayerId || '');
        if (activeIndex !== -1) {
          nextActiveId = nextOrder[activeIndex - 1] || nextOrder[activeIndex] || nextOrder[0] || null;
        }
      }

      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: {
              ...frame,
              layers: { byId: nextById, order: nextOrder },
              activeLayerId: nextActiveId ?? null
            }
          }
        }
      };
    }

    case 'UPDATE_VIEW_SIZE':
      if (state.ui.viewportDim.w === action.payload.w && state.ui.viewportDim.h === action.payload.h) return state;
      return { ...state, ui: { ...state.ui, viewportDim: action.payload } };

    case 'SET_INTERACTION':
      return {
        ...state,
        interaction: {
          ...state.interaction,
          ...action.payload,
          signals: action.payload.signals
            ? { ...(state.interaction.signals || {}), ...action.payload.signals }
            : (state.interaction.signals || {})
        }
      };

    case 'TOGGLE_INTERACTION_SIGNAL': {
      const key = action.payload;
      const current = !!state.interaction.signals?.[key];
      return {
        ...state,
        interaction: {
          ...state.interaction,
          signals: {
            ...(state.interaction.signals || {}),
            [key]: !current
          }
        }
      };
    }

    // ─── Per-Frame History: SIGNAL_COMMIT ─────────────────────────────────
    case 'SIGNAL_COMMIT': {
      const frameId = action.payload.frameId;
      if (!frameId || !state.frames.byId[frameId]) return state;

      const frameHistory = state.history.byFrameId[frameId] ?? { past: [], future: [], checkpoint: null };
      const currentFrame = state.frames.byId[frameId];

      let nextPast = frameHistory.past;
      let nextFuture = frameHistory.future;

      if (frameHistory.checkpoint) {
        // Diff checkpoint vs current frame using Immer produceWithPatches
        const [, patches, inversePatches] = produceWithPatches(frameHistory.checkpoint, (draft) => {
          reconcileFrameState(draft, currentFrame);
        });

        if (patches.length > 0) {
          // [Architecture Design: Strict physical change determination and Redo stack protection rules]
          // - Only when actual document physical changes occur (patches.length > 0) is a new historical Edit Step generated.
          // - Likewise, only at this point do we reset/clear the future stack (future = []).
          const step = {
            id: Math.random().toString(36).substring(2, 9),
            name: 'Edit',
            undoPatches: inversePatches,
            redoPatches: patches,
          };
          nextPast = [...nextPast.slice(-(MAX_HISTORY_STEPS - 1)), step];
          nextFuture = []; // Only clear Redo stack when a new change is made
        }
      }

      // Set new checkpoint to current frame state
      const updatedFrameHistory: FrameHistoryState = {
        past: nextPast,
        future: nextFuture,
        checkpoint: currentFrame
      };

      return {
        ...state,
        history: {
          byFrameId: {
            ...state.history.byFrameId,
            [frameId]: updatedFrameHistory
          }
        }
      };
    }

    // ─── Per-Frame History: UNDO ──────────────────────────────────────────
    case 'HISTORY_UNDO': {
      const frameId = state.activeFrameId;
      if (!frameId || !state.frames.byId[frameId]) return state;

      const frameHistory = state.history.byFrameId[frameId];
      if (!frameHistory || (frameHistory.past.length === 0 && !frameHistory.checkpoint)) return state;

      const currentFrame = state.frames.byId[frameId];
      let undoPatches: Patch[] = [];
      const past = [...frameHistory.past];
      let future = [...frameHistory.future];

      if (frameHistory.checkpoint) {
        // Diff checkpoint vs current to capture any unsaved changes before undo
        const [, patches, inversePatches] = produceWithPatches(frameHistory.checkpoint, (draft) => {
          reconcileFrameState(draft, currentFrame);
        });

        if (patches.length > 0) {
          // There are unsaved changes since last commit — treat them as a step
          undoPatches = inversePatches;
          const step = {
            id: Math.random().toString(36).substring(2, 9),
            name: 'Edit',
            undoPatches: inversePatches,
            redoPatches: patches,
          };
          future = [step, ...future];
        } else if (past.length > 0) {
          const step = past.pop()!;
          undoPatches = step.undoPatches;
          future = [step, ...future];
        } else {
          return state;
        }
      } else {
        if (past.length === 0) return state;
        const step = past.pop()!;
        undoPatches = step.undoPatches;
        future = [step, ...future];
      }

      // Apply undo patches directly to the frame
      const restoredFrame = mergeLiveCameraForFrame(applyPatches(currentFrame, undoPatches), currentFrame);

      const updatedFrameHistory: FrameHistoryState = {
        past,
        future,
        checkpoint: null
      };

      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: restoredFrame
          }
        },
        history: {
          byFrameId: {
            ...state.history.byFrameId,
            [frameId]: updatedFrameHistory
          }
        }
      };
    }

    // ─── Per-Frame History: REDO ──────────────────────────────────────────
    case 'HISTORY_REDO': {
      const frameId = state.activeFrameId;
      if (!frameId || !state.frames.byId[frameId]) return state;

      const frameHistory = state.history.byFrameId[frameId];
      if (!frameHistory || frameHistory.future.length === 0) return state;

      const currentFrame = state.frames.byId[frameId];
      const future = [...frameHistory.future];
      const step = future.shift()!;

      // Apply redo patches directly to the frame
      const restoredFrame = mergeLiveCameraForFrame(applyPatches(currentFrame, step.redoPatches), currentFrame);

      const updatedFrameHistory: FrameHistoryState = {
        past: [...frameHistory.past, step],
        future,
        checkpoint: null
      };

      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: restoredFrame
          }
        },
        history: {
          byFrameId: {
            ...state.history.byFrameId,
            [frameId]: updatedFrameHistory
          }
        }
      };
    }


    case 'HYDRATE': {
      const payload = { ...action.payload };

      let migratedFrames = payload.frames;
      let migratedHistory: GlobalHistoryState | undefined = undefined;

      // Migrate legacy Array frames to NormalizedState
      if (Array.isArray(migratedFrames)) {
        const legacyFrames = migratedFrames as unknown as Frame[];
        const order = legacyFrames.map(f => f.id);
        const byId: Record<string, Frame> = {};
        legacyFrames.forEach(f => {
          let layers = f.layers as unknown;
          if (Array.isArray(layers)) {
            const legacyLayers = layers as Layer[];
            const lOrder = legacyLayers.map(l => l.id);
            const lById: Record<string, Layer> = {};
            legacyLayers.forEach(l => (lById[l.id] = l));
            layers = { byId: lById, order: lOrder };
          }
          byId[f.id] = { ...f, layers: layers as Frame['layers'] };
        });
        migratedFrames = { byId, order };

        // Legacy history patches are incompatible with new shape, must clear them
        migratedHistory = { byFrameId: {} };
      } else if (migratedFrames && migratedFrames.byId) {
        // Even if frames is an object, make sure layers inside are migrated if they are arrays
        const nextOrder = migratedFrames.order || [];
        const nextById = { ...migratedFrames.byId };
        let historyIncompatible = false;
        
        Object.keys(nextById).forEach(fId => {
          const f = nextById[fId];
          if (f.layers && Array.isArray(f.layers)) {
            const legacyLayers = f.layers as unknown as Layer[];
            const lOrder = legacyLayers.map(l => l.id);
            const lById: Record<string, Layer> = {};
            legacyLayers.forEach(l => (lById[l.id] = l));
            nextById[fId] = { ...f, layers: { byId: lById, order: lOrder } };
            historyIncompatible = true;
          }
        });

        migratedFrames = { byId: nextById, order: nextOrder };
        if (historyIncompatible) {
          migratedHistory = { byFrameId: {} };
        }
      }

      // [Migration] masks -> vectorMasks: Automatically migrate legacy data
      if (migratedFrames && migratedFrames.byId) {
        Object.keys(migratedFrames.byId).forEach(fId => {
          const f = migratedFrames!.byId[fId];
          if (f.layers && f.layers.byId) {
            Object.keys(f.layers.byId).forEach(lId => {
              const layer = f.layers.byId[lId] as Layer & { masks?: unknown[] };
              if (layer.masks && !layer.vectorMasks) {
                (layer as Layer).vectorMasks = layer.masks as Layer['vectorMasks'];
                delete layer.masks;
              }
            });
          }
        });
      }

      // [Migration] Legacy global history → per-frame history
      // If payload.history has the old shape { past, future, checkpoint }, convert it
      const rawHistory = payload.history as unknown;
      if (rawHistory && typeof rawHistory === 'object' && 'past' in (rawHistory as object) && !('byFrameId' in (rawHistory as object))) {
        // Old format: discard — patches used global frame paths, incompatible with per-frame
        migratedHistory = { byFrameId: {} };
      }

      // Determine final history: prefer migratedHistory > payload.history (if new format) > state.history > empty
      let finalHistory: GlobalHistoryState;
      if (migratedHistory) {
        finalHistory = migratedHistory;
      } else if (payload.history && 'byFrameId' in payload.history) {
        finalHistory = payload.history as GlobalHistoryState;
      } else {
        finalHistory = state.history || { byFrameId: {} };
      }

      return {
        // [Standardization] Persistence restoration is a crash-prone period; we must first destructure old state to retain command sets
        // then destructure payload to override business data (frames, config, etc.)
        ...state,
        ...payload,
        frames: migratedFrames || state.frames,
        // Ensure UI and History always have fallback values to prevent component crashes due to empty data
        ui: payload.ui ? { ...state.ui, ...payload.ui } : state.ui,
        pluginConfig: payload.pluginConfig ? { ...state.pluginConfig, ...payload.pluginConfig } : state.pluginConfig,
        history: finalHistory,
        isLoaded: true,
        confirm: null,
      };
    }

    case 'SET_HISTORY':
      return { ...state, history: action.payload };

    case 'SHOW_CONFIRM':
      return {
        ...state,
        confirm: {
          isVisible: true,
          title: action.payload.title,
          message: action.payload.message,
          type: action.payload.type || 'info',
          variant: action.payload.variant || 'square'
        }
      };

    case 'HIDE_CONFIRM':
      return { ...state, confirm: null };

    case 'SHOW_CHOICE':
      return {
        ...state,
        choice: { isVisible: true, ...action.payload }
      };
    case 'HIDE_CHOICE':
      return { ...state, choice: null };




    case 'SET_STORAGE_USAGE':
      return { ...state, storageUsage: action.payload };

    case 'UPDATE_UI':
      return { ...state, ui: { ...state.ui, ...action.payload } };

    case 'SET_ENGINE_STATUS':
      return {
        ...state,
        runtime: {
          ...state.runtime,
          engineStatuses: action.payload
        }
      };

    // ─── Generic Frame/History Operations ─────────────────────────────────
    // Used by plugins (e.g. CloudMenu) via standard dispatch.
    // Not cloud-specific — also useful for "New Project", version rollback, etc.

    case 'HISTORY_RESET': {
      // Reset only the active frame's history (per-frame undo floor)
      const resetFrameId = state.activeFrameId;
      if (!resetFrameId) {
        return { ...state, history: { byFrameId: {} } };
      }
      return {
        ...state,
        history: {
          byFrameId: {
            ...state.history.byFrameId,
            [resetFrameId]: { past: [], future: [], checkpoint: null }
          }
        }
      };
    }

    case 'REPLACE_FRAME': {
      const { frameId, frame } = action.payload;
      if (!state.frames.byId[frameId]) return state;
      return {
        ...state,
        frames: {
          ...state.frames,
          byId: {
            ...state.frames.byId,
            [frameId]: frame
          }
        }
      };
    }

    default:
      return state;
  }
}
