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

import { EditorData, EditorAction, Frame, Layer, HistoryCheckpoint } from '@opengpex/editor/core/types';
import { produceWithPatches, enablePatches, applyPatches, Patch } from 'immer';
import { reconcileEditorState, mergeLiveCameras } from './reducer-utils';

enablePatches();

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
  interaction: {
    smartguides: null,
    interactionMode: 'pan',
    isInteracting: false,
    isSnapping: true,
    signals: {},
    cursorOverride: null,
  },
  history: {
    past: [],
    future: [],
    checkpoint: null
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
        history: {
          ...state.history,
          checkpoint: state.history.checkpoint ? {
            ...state.history.checkpoint,
            frames: nextFrames,
            activeFrameId: nextActiveFrameId
          } : null
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

      // 2. History snapshot cleanup (Reducer housekeeping: clean up deleted frame references in checkpoint)
      const filterPatches = (patches: Patch[]) => patches.filter(p => {
        if (p.path[0] === 'frames' && p.path[1] === 'byId') {
           const frameId = p.path[2] as string;
           if (idsToRemove.has(frameId)) return false;
        }
        return true;
      });

      const nextPast = state.history.past.map(step => ({
        ...step,
        activeFrameIdBefore: idsToRemove.has(step.activeFrameIdBefore || '') ? nextActiveFrameId : step.activeFrameIdBefore,
        activeFrameIdAfter: idsToRemove.has(step.activeFrameIdAfter || '') ? nextActiveFrameId : step.activeFrameIdAfter,
        undoPatches: filterPatches(step.undoPatches),
        redoPatches: filterPatches(step.redoPatches)
      })).filter(step => step.undoPatches.length > 0 || step.redoPatches.length > 0);

      const nextFuture = state.history.future.map(step => ({
        ...step,
        activeFrameIdBefore: idsToRemove.has(step.activeFrameIdBefore || '') ? nextActiveFrameId : step.activeFrameIdBefore,
        activeFrameIdAfter: idsToRemove.has(step.activeFrameIdAfter || '') ? nextActiveFrameId : step.activeFrameIdAfter,
        undoPatches: filterPatches(step.undoPatches),
        redoPatches: filterPatches(step.redoPatches)
      })).filter(step => step.undoPatches.length > 0 || step.redoPatches.length > 0);

      const filterCheckpoint = (checkpoint: HistoryCheckpoint | null) => {
        if (!checkpoint) return null;
        const filteredOrder = checkpoint.frames.order.filter((id: string) => !idsToRemove.has(id));
        const filteredById = { ...checkpoint.frames.byId };
        idsToRemove.forEach((id: string) => delete filteredById[id]);
        
        let nextSnapActiveId = checkpoint.activeFrameId;
        if (idsToRemove.has(checkpoint.activeFrameId || '')) {
          nextSnapActiveId = filteredOrder.length > 0 ? filteredOrder[0] : null;
        }
        return {
          ...checkpoint,
          frames: { byId: filteredById, order: filteredOrder },
          activeFrameId: nextSnapActiveId
        };
      };

      return {
        ...state,
        frames: { byId: nextById, order: nextOrder },
        activeFrameId: nextActiveFrameId,
        history: {
          past: nextPast,
          future: nextFuture,
          checkpoint: filterCheckpoint(state.history.checkpoint)
        }
      };
    }


    case 'CLEAR_ALL_DATA': {
      return { ...state, frames: { byId: {}, order: [] }, activeFrameId: null };
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
      // - If the deleted layers include the currently active layer, and no next active layer ID is assigned from above,
      // - we will automatically activate the previous valid layer adjacent to its original position (or the next one if none, or fall back to the first in the remaining list) to physically prevent selection loss (loss of focus) in the layer list.
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

    case 'SIGNAL_COMMIT': {
      let past = state.history.past;
      const checkpoint = state.history.checkpoint;
      let future = state.history.future;

      if (checkpoint) {
        const base = {
          frames: checkpoint.frames,
          activeFrameId: checkpoint.activeFrameId
        };
        const [, patches, inversePatches] = produceWithPatches(base, (draft) => {
          reconcileEditorState(draft, state);
        });

        if (patches.length > 0) {
          // [Architecture Design: Strict physical change determination and Redo stack protection rules]
          // - Only when actual document physical changes occur (patches.length > 0) is a new historical Edit Step generated and pushed to the past stack.
          // - Likewise, only at this point do we reset/clear the future stack (future = []).
          // - If patches.length === 0 (e.g., empty commits with no physical changes triggered by switchFrame or updateCamera),
          //   we must not clear the user's redo stack; future should be kept as-is, preventing it from being wiped out by accidental factors like component lifecycle re-renders.
          const step = {
            id: Math.random().toString(36).substring(2, 9),
            name: 'Edit',
            undoPatches: inversePatches,
            redoPatches: patches,
            activeFrameIdBefore: checkpoint.activeFrameId,
            activeFrameIdAfter: state.activeFrameId
          };
          past = [...past.slice(-49), step];
          future = []; // Only clear Redo stack when a new change is made
        }
      }

      return {
        ...state,
        history: {
          past,
          future,
          checkpoint: {
            frames: state.frames,
            activeFrameId: state.activeFrameId
          }
        }
      };
    }

    case 'HISTORY_UNDO': {
      const { history } = state;
      if (history.past.length === 0 && !history.checkpoint) return state;

      let undoPatches: Patch[] = [];
      let activeFrameIdBefore: string | null = null;
      const past = [...history.past];
      let future = [...history.future];

      if (history.checkpoint) {
        const base = {
          frames: history.checkpoint.frames,
          activeFrameId: history.checkpoint.activeFrameId
        };
        const [, patches, inversePatches] = produceWithPatches(base, (draft) => {
          reconcileEditorState(draft, state);
        });

        if (patches.length > 0) {
          undoPatches = inversePatches;
          activeFrameIdBefore = history.checkpoint.activeFrameId;

          const step = {
            id: Math.random().toString(36).substring(2, 9),
            name: 'Edit',
            undoPatches: inversePatches,
            redoPatches: patches,
            activeFrameIdBefore: history.checkpoint.activeFrameId,
            activeFrameIdAfter: state.activeFrameId
          };
          future = [step, ...future];
        } else if (past.length > 0) {
          const step = past.pop()!;
          undoPatches = step.undoPatches;
          activeFrameIdBefore = step.activeFrameIdBefore;
          future = [step, ...future];
        } else {
          return state;
        }
      } else {
        if (past.length === 0) return state;
        const step = past.pop()!;
        undoPatches = step.undoPatches;
        activeFrameIdBefore = step.activeFrameIdBefore;
        future = [step, ...future];
      }

      // Apply undo patches
      const baseObj = { frames: state.frames, activeFrameId: state.activeFrameId };
      const nextObj = applyPatches(baseObj, undoPatches);

      // Merge live cameras to prevent viewport jumping on undo
      const restoredFrames = mergeLiveCameras(nextObj.frames, state);

      return {
        ...state,
        frames: restoredFrames,
        activeFrameId: activeFrameIdBefore ?? nextObj.activeFrameId,
        history: { past, future, checkpoint: null }
      };
    }

    case 'HISTORY_REDO': {
      const { history } = state;
      if (history.future.length === 0) return state;

      const future = [...history.future];
      const step = future.shift()!;

      // Apply redo patches
      const baseObj = { frames: state.frames, activeFrameId: state.activeFrameId };
      const nextObj = applyPatches(baseObj, step.redoPatches);

      // Merge live cameras to prevent viewport jumping on redo
      const restoredFrames = mergeLiveCameras(nextObj.frames, state);

      return {
        ...state,
        frames: restoredFrames,
        activeFrameId: step.activeFrameIdAfter ?? nextObj.activeFrameId,
        history: { past: [...history.past, step], future, checkpoint: null }
      };
    }


    case 'HYDRATE': {
      const payload = { ...action.payload };

      let migratedFrames = payload.frames;
      let migratedHistory = payload.history;

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
        migratedHistory = { past: [], future: [], checkpoint: null };
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
          migratedHistory = { past: [], future: [], checkpoint: null };
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

      return {
        // [Standardization] Persistence restoration is a crash-prone period; we must first destructure old state to retain command sets
        // then destructure payload to override business data (frames, config, etc.)
        ...state,
        ...payload,
        frames: migratedFrames || state.frames,
        // Ensure UI and History always have fallback values to prevent component crashes due to empty data
        ui: payload.ui ? { ...state.ui, ...payload.ui } : state.ui,
        pluginConfig: payload.pluginConfig ? { ...state.pluginConfig, ...payload.pluginConfig } : state.pluginConfig,
        history: migratedHistory || state.history || { past: [], future: [], checkpoint: null },
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

    case 'HISTORY_RESET':
      return {
        ...state,
        history: { past: [], future: [], checkpoint: null }
      };

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
