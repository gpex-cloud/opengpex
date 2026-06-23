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

import { useReducer, useMemo, useRef, useCallback, useEffect } from 'react';
import {
  EditorData, EditorState, EditorAction, Layer, Frame, CameraState, UIConfig,
  BuiltPlugin, EditorShortcut, BuiltCommand, Dimensions, NormalizedState,
  EditorActions, EditorContextValue, GlobalHistoryState, EngineStatus, LocalShape,
  InteractionSignalValue, ClipboardLayerMetadata, BitmapMask, LocalPolygon
} from '@opengpex/editor/core/types';
import { LayerUtils } from '@opengpex/editor/core/layer/LayerUtils';
import { initialState, editorReducer } from './reducer';
import { useVolatileState } from './useVolatileState';
import * as P from '@opengpex/editor/core/advanced/protocols';
import { snapCropBoxToPixels } from '@opengpex/editor/core/helpers/sub-pixel';

/**
 * useEditorStore: Core state and action integration Hook
 * 
 * This Hook is the "engine" of the entire editor. It aggregates:
 * 1. State management (useReducer)
 * 2. Command interception and dispatching (Enhanced Dispatcher / Plugin Interceptors)
 * 3. Asset lifecycle sentinel (Asset Sentinel)
 * 4. Semantic action definition (Semantic Actions)
 * 5. High-frequency interaction fast-track reference (Volatile Refs)
 */
export function useEditorStore() {
  const [state, dispatch] = useReducer(editorReducer, initialState);

  // --- 1. Core Reference Management (Internal Refs) ---
  const isHydrated = useRef(false);
  const stateRef = useRef<EditorData>(state);
  const frameRef = useRef<Frame | null>(null);
  const layerRef = useRef<Layer | null>(null);
  const contextValueRef = useRef<EditorContextValue | null>(null);

  const {
    volatileRef,
    mutate: mutateVolatile,
    update: updateVolatile,
    commit: commitVolatile,
    reset: resetVolatile
  } = useVolatileState();

  // --- 2. Asset Sentinel Scheduler (Asset Sentinel) ---
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ASSET_CRITICAL_ACTIONS = useMemo<Set<EditorAction['type']>>(() => new Set([
    'ADD_LAYER', 'REMOVE_LAYERS', 'REMOVE_FRAME', 'CLEAR_ALL_DATA',
    'SIGNAL_COMMIT', 'HYDRATE', 'SET_HISTORY'
    /**
     * [Critical Architecture Warning] Do not add persistent storage operations to this set!
     * Reason: After GC (Garbage Collection) execution completes, state synchronization may be triggered.
     * If a synchronous action is included in this set, it will trigger an infinite loop: GC -> sync -> scheduleSync -> GC.
     */
  ]), []);

  const scheduleAssetSync = useCallback((force = false) => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      const ctx = contextValueRef.current;
      if (!ctx) return;
      // 💡 Directly call the gc of the underlying storage service for garbage collection, bypassing the command link dispatched by Action, to maintain the purity of background cleanup
      ctx.storage.gc(stateRef.current, force).catch(err => {
        console.error('[AssetSentinel] Background GC failed:', err);
      });
    }, 2000);
  }, []);

  // --- 3. Enhanced Dispatcher (Enhanced Dispatcher) ---
  const enhancedDispatch = useCallback((action: EditorAction) => {
    const currentState = stateRef.current;

    if (isHydrated.current) {
      // A. Plugin system broadcast (triggered asynchronously via microtask)
      queueMicrotask(() => {
        const context = contextValueRef.current;
        if (!context) return;

        context.plugins.getAllPlugins().forEach(p => {
          if (p.onAction) {
            try {
              p.onAction(action, currentState as unknown as EditorState, context.actions);
            } catch (err) {
              console.error(`Plugin ${p.uid} onAction failed:`, err);
            }
          }
        });
      });

      // B. Smart asset sentinel interception (Smart Asset Sentinel)
      let needsSync = ASSET_CRITICAL_ACTIONS.has(action.type);
      if (action.type === 'UPDATE_LAYER' && (action.payload.patch?.assetId || action.payload.patch?.src)) {
        needsSync = true;
      }
      if (needsSync) {
        const force = action.type === 'REMOVE_FRAME' || action.type === 'CLEAR_ALL_DATA';
        scheduleAssetSync(force);
      }

      // C. [Architecture Fix] Fast-track Garbage Collection
      // The logic here is like Redux Middleware, ensuring that when slow-track data is deleted, fast-track shadows are removed synchronously.
      if (action.type === 'REMOVE_LAYERS') {
        const { frameId, layerIds } = action.payload;
        mutateVolatile(v => {
          layerIds.forEach(layerId => {
            delete v.buffered.layers[LayerUtils.getCompositeKey(frameId, layerId)];
          });
        });
      } else if (action.type === 'REMOVE_FRAME') {
        const { frameIds } = action.payload;
        mutateVolatile(v => {
          frameIds.forEach(fId => {
            Object.keys(v.buffered.layers).forEach(key => {
              if (key.startsWith(`${fId}:`)) delete v.buffered.layers[key];
            });
            delete v.buffered.frames[fId];
          });
        });
      }
    }

    // D. [Unified Architecture Snapping Gateway] 
    // Standardize subpixel physical alignment for the image crop box (imageCropBox) at the dispatch entry.
    // Completely resolves subpixel deviation issues between "logical cropping" and "physical cropping" caused by actions like Reset, manual settings, aspect ratio locking, etc.
    let alignedAction = action;
    if (action.type === 'SET_IMAGE_CROP_BOX') {
      const { cropBox } = action.payload;
      if (cropBox) {
        alignedAction = {
          ...action,
          payload: { ...action.payload, cropBox: snapCropBoxToPixels(cropBox) }
        };
      }
    } else if (action.type === 'UPDATE_FRAME') {
      const { patch } = action.payload;
      if (patch?.imageCropBox) {
        alignedAction = {
          ...action,
          payload: {
            ...action.payload,
            patch: { ...patch, imageCropBox: snapCropBoxToPixels(patch.imageCropBox) }
          }
        };
      }
    } else if (action.type === 'BATCH_UPDATE_FRAME') {
      const { patches } = action.payload;
      if (patches) {
        const alignedPatches = { ...patches };
        let mutated = false;
        for (const [fId, p] of Object.entries(alignedPatches)) {
          if (p?.imageCropBox) {
            alignedPatches[fId] = {
              ...p,
              imageCropBox: snapCropBoxToPixels(p.imageCropBox)
            };
            mutated = true;
          }
        }
        if (mutated) {
          alignedAction = {
            ...action,
            payload: { ...action.payload, patches: alignedPatches }
          };
        }
      }
    }

    dispatch(alignedAction);
  }, [scheduleAssetSync, ASSET_CRITICAL_ACTIONS, mutateVolatile]);

  const confirmResolverRef = useRef<((val: boolean) => void) | null>(null);

  // --- 4. Semantic Action Definition (Semantic Actions) ---
  const actions: EditorActions = useMemo(() => {
    const executeCommand = <P = unknown, R = unknown>(id: string, payload?: P): R => {
      const currentStore = stateRef.current;
      const context = contextValueRef.current;
      if (!context) return undefined as R;

      // Helper function: construct context under a specific plugin scope
      const createScopedContext = (pluginUid: string, initialConfig?: Record<string, unknown>): EditorContextValue => {
        return {
          ...context,
          scoped: {
            selfConfig: currentStore.pluginConfig[pluginUid] || initialConfig || {},
            setSelfConfig: (patch: Record<string, unknown>) => {
              context.actions.updatePluginConfig(pluginUid, patch);
            },
            getSignal: <T = boolean>(key: string, defaultValue?: T): T => {
              const targetKey = key.startsWith(pluginUid) ? key : `${pluginUid}.${key}`;
              return context.state.getStateSignal(targetKey, defaultValue);
            },
            setSignal: (key: string, value: InteractionSignalValue) => {
              const targetKey = key.startsWith(pluginUid) ? key : `${pluginUid}.${key}`;
              context.actions.setStateSignal(targetKey, value);
            },
            toggleSignal: (key: string) => {
              const targetKey = key.startsWith(pluginUid) ? key : `${pluginUid}.${key}`;
              context.actions.toggleStateSignal(targetKey);
            }
          }
        };
      };

      // 1. Command interceptors (Interceptors)
      const allPlugins = context.plugins.getAllPlugins();
      if (allPlugins) {
        for (const plugin of allPlugins) {
          const commandInterceptor = plugin.interceptors?.command;
          if (commandInterceptor?.beforeExecute) {
            if (id.startsWith('adv.')) continue;
            try {
              const scopedContext = createScopedContext(plugin.uid, plugin.initialConfig);
              const isConsumed = commandInterceptor.beforeExecute(id, scopedContext);
              if (isConsumed === true) return undefined as R;
            } catch (error) {
              console.error(`[OpenGPEX Error] Interceptor Failed in Plugin ${plugin.uid}:`, error);
            }
          }
        }
      }

      // 2. Default execution logic
      const command = context.plugins.getCommand(id);
      if (command) {
        if (command.undoable && currentStore.activeFrameId) {
          dispatch({ type: 'SIGNAL_COMMIT', payload: { frameId: currentStore.activeFrameId } });
        }

        const allPlugins = context.plugins.getAllPlugins();
        const owningPlugin = allPlugins.find(p =>
          p.commands?.some(cmd => cmd.uid === id)
        );

        const scopedContext = owningPlugin
          ? createScopedContext(owningPlugin.uid, owningPlugin.initialConfig)
          : context;

        try {
          return command.execute(scopedContext, payload as never) as R;
        } catch (error) {
          console.error(`[OpenGPEX Error] Command Execution Failed (${id}):`, error);
          // Graceful degradation: prevents crashes from bubbling up and causing React or Zustand to be unmounted entirely. If there is a toast, it can be popped here.
          return undefined as R;
        }
      }
      return undefined as R;
    };

    const frameActions = {
      addFrame: (frame: Frame, switchFrame = true) => {
        const currentStore = stateRef.current;
        // [Defensive Programming: Idempotent Defense Line]
        // - If the artboard to be added or activated is already the currently active artboard, intercept and return directly; never execute reset and subsequent dispatch.
        // - This significantly optimizes React rendering performance under high-frequency interactions/redraws, and fundamentally eliminates the risk of history stack clearing due to repeated state synchronization or side effect backflow.
        if (currentStore.activeFrameId === frame.id) return;
        if (switchFrame) resetVolatile();
        if (currentStore.activeFrameId) {
          enhancedDispatch({ type: 'SIGNAL_COMMIT', payload: { frameId: currentStore.activeFrameId } });
        }
        enhancedDispatch({ type: 'ADD_FRAME', payload: { frame, switchFrame } });
      },
      switchFrame: (id: string) => {
        const currentStore = stateRef.current;
        // [Defensive Programming: Idempotent Defense Line]
        // If the target frame is already the currently active artboard, immediately return idempotently to prevent repeated SIGNAL_COMMIT from wiping out the Redo stack.
        if (currentStore.activeFrameId === id) return;
        resetVolatile();
        if (currentStore.activeFrameId) {
          enhancedDispatch({ type: 'SIGNAL_COMMIT', payload: { frameId: currentStore.activeFrameId } });
        }
        enhancedDispatch({ type: 'SWITCH_FRAME', payload: id });
      },
      updateFrame: (id: string, patch: Partial<Frame>) => enhancedDispatch({ type: 'UPDATE_FRAME', payload: { id, patch } }),
      removeFrame: (frameIds: string[], nextActiveFrameId: string | null) => {
        resetVolatile();
        enhancedDispatch({ type: 'REMOVE_FRAME', payload: { frameIds, nextActiveFrameId } });
      },
      reorderFrames: (oldIndex: number, newIndex: number) => enhancedDispatch({ type: 'REORDER_FRAMES', payload: { oldIndex, newIndex } }),
      setFrames: (frames: Frame[] | NormalizedState<Frame>) => {
        const payload = Array.isArray(frames)
          ? { byId: Object.fromEntries(frames.map(f => [f.id, f])), order: frames.map(f => f.id) }
          : frames;
        enhancedDispatch({ type: 'SET_FRAMES', payload });
      },
      setImageCropBox: (frameId: string, cropBox: LocalShape) => enhancedDispatch({ type: 'SET_IMAGE_CROP_BOX', payload: { frameId, cropBox } }),
      setCanvasCropBox: (frameId: string, cropBox: LocalShape) => enhancedDispatch({ type: 'SET_CANVAS_CROP_BOX', payload: { frameId, cropBox } }),
      setIrregularCropBox: (frameId: string, polygon: LocalPolygon | null) =>
        enhancedDispatch(
          polygon == null
            ? { type: 'CLEAR_IRREGULAR_CROP_BOX', payload: { frameId } }
            : { type: 'SET_IRREGULAR_CROP_BOX', payload: { frameId, polygon } }
        ),
      setImageAspect: (frameId: string, aspect: number | undefined) => enhancedDispatch({ type: 'SET_IMAGE_ASPECT', payload: { frameId, aspect } }),
      setCanvasAspect: (frameId: string, aspect: number | undefined) => enhancedDispatch({ type: 'SET_CANVAS_ASPECT', payload: { frameId, aspect } }),
      updateCamera: (frameId: string, camera: CameraState) => enhancedDispatch({ type: 'UPDATE_CAMERA', payload: { frameId, camera } }),
    };
    const layerActions = {
      addLayers: (frameId: string, layers: Layer[], index?: number) => {
        enhancedDispatch({ type: 'ADD_LAYER', payload: { frameId, layers, index } });
      },
      updateLayer: (frameId: string, layerId: string, patch: Partial<Layer>) => {
        enhancedDispatch({ type: 'UPDATE_LAYER', payload: { frameId, layerId, patch } });
      },
      batchUpdateLayers: (frameId: string, patches: Record<string, Partial<Layer>>) => {
        enhancedDispatch({ type: 'BATCH_UPDATE_LAYER', payload: { frameId, patches } });
      },
      removeLayers: (frameId: string, layerIds: string[], nextActiveLayerId?: string | null) =>
        enhancedDispatch({
          type: 'REMOVE_LAYERS',
          payload: { frameId, layerIds, nextActiveLayerId }
        }),
      reorderLayers: (frameId: string, oldIndex: number, newIndex: number) => enhancedDispatch({ type: 'REORDER_LAYERS', payload: { frameId, oldIndex, newIndex } }),
      setLayers: (frameId: string, layers: Layer[]) => {
        enhancedDispatch({ type: 'SET_LAYERS', payload: { frameId, layers } });
      },
      setActiveLayer: (frameId: string, layerId: string | null) => {
        enhancedDispatch({ type: 'SET_ACTIVE_LAYER', payload: { frameId, layerId } });
      },
    };
    const uiActions = {
      updateUI: (patch: Partial<UIConfig>) => enhancedDispatch({ type: 'UPDATE_UI', payload: patch }),
      updateViewSize: (size: { w: number; h: number }) => enhancedDispatch({ type: 'UPDATE_VIEW_SIZE', payload: size }),
      setInteraction: (patch: Partial<EditorData['interaction']>) => enhancedDispatch({ type: 'SET_INTERACTION', payload: patch }),
      setStateSignal: (key: string, value: InteractionSignalValue) => enhancedDispatch({ type: 'SET_INTERACTION', payload: { signals: { [key]: value } } }),
      toggleStateSignal: (key: string) => enhancedDispatch({ type: 'TOGGLE_INTERACTION_SIGNAL', payload: key }),
      withSignal: async <T>(key: string, task: () => Promise<T>): Promise<T> => {
        enhancedDispatch({ type: 'SET_INTERACTION', payload: { signals: { [key]: true } } });
        try {
          return await task();
        } finally {
          enhancedDispatch({ type: 'SET_INTERACTION', payload: { signals: { [key]: false } } });
        }
      },
      notifyHUD: (message: string, type: 'info' | 'success' | 'error' = 'info') => {
        enhancedDispatch({ type: 'SET_INTERACTION', payload: { hud: { message, type } } });
      },
      askConfirm: (title: string, message: string, type: 'info' | 'danger' | 'warning' = 'info', variant: 'square' | 'rect' = 'square') => {
        return new Promise<boolean>((resolve) => {
          confirmResolverRef.current = resolve;
          enhancedDispatch({ type: 'SHOW_CONFIRM', payload: { title, message, type, variant } });
        });
      },
      confirm: (val: boolean) => {
        if (confirmResolverRef.current) {
          confirmResolverRef.current(val);
          confirmResolverRef.current = null;
        }
        enhancedDispatch({ type: 'HIDE_CONFIRM' });
      },
    };

    const pluginActions = {
      registerPlugin: (plugin: BuiltPlugin) => {
        const ctx = contextValueRef.current;
        if (ctx) ctx.plugins.registerPlugin(plugin);

        // Automatically initialize default values of registered signals into the state machine
        if (plugin.signals) {
          const initialSignals: Record<string, InteractionSignalValue> = {};
          plugin.signals.forEach(sig => {
            const key = sig.uid;
            initialSignals[key] = sig.defaultValue;
          });
          enhancedDispatch({ type: 'SET_INTERACTION', payload: { signals: initialSignals } });
        }

        if (plugin.initialConfig) {
          enhancedDispatch({ type: 'INIT_PLUGIN_CONFIG', payload: { pluginId: plugin.uid, initialConfig: plugin.initialConfig } });
        }
      },
      unregisterPlugin: (id: string) => {
        const ctx = contextValueRef.current;
        if (ctx) ctx.plugins.unregisterPlugin(id);
      },
      updatePluginConfig: (pluginId: string, patch: Record<string, unknown>) => enhancedDispatch({ type: 'UPDATE_PLUGIN_CONFIG', payload: { pluginId, patch } }),
      getPluginConfig: (pluginId: string) => stateRef.current.pluginConfig[pluginId] as Record<string, unknown> | undefined,
      registerShortcut: (shortcut: EditorShortcut) => {
        const ctx = contextValueRef.current;
        if (ctx) ctx.plugins.registerShortcut(shortcut);
      },
      unregisterShortcut: (id: string) => {
        const ctx = contextValueRef.current;
        if (ctx) ctx.plugins.unregisterShortcut(id);
      },
      registerCommand: (command: BuiltCommand) => {
        const ctx = contextValueRef.current;
        if (ctx) ctx.plugins.registerCommand(command);
      },
    };

    // Helper: Create advanced command rich reference object (AdvCommandRef)
    // Both name and shortcutLabel are dynamically obtained from the plugins service, avoiding hardcoded redundancy
    /* eslint-disable react-hooks/refs */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function advRef(cmdId: string, executor: (...args: any[]) => any) {
      return {
        id: cmdId,
        get name() {
          const ctx = contextValueRef.current;
          return ctx?.plugins.getCommand(cmdId)?.name || cmdId;
        },
        get shortcutLabel() {
          const ctx = contextValueRef.current;
          return ctx ? ctx.plugins.getShortcutLabel(cmdId, true) : '';
        },
        execute: executor,
      };
    }

    const advActions = {
      adv: {
        viewport: {
          transform: {
            rotate: advRef(P.ADV_VIEWPORT_ROTATE, (payload: { direction: 'left' | 'right' }) => executeCommand(P.ADV_VIEWPORT_ROTATE, payload)),
            rotateLeft: advRef(P.ADV_VIEWPORT_ROTATE_LEFT, () => executeCommand(P.ADV_VIEWPORT_ROTATE_LEFT)),
            rotateRight: advRef(P.ADV_VIEWPORT_ROTATE_RIGHT, () => executeCommand(P.ADV_VIEWPORT_ROTATE_RIGHT)),
            flip: advRef(P.ADV_VIEWPORT_FLIP, (payload: { direction: 'horizontal' | 'vertical' }) => executeCommand(P.ADV_VIEWPORT_FLIP, payload)),
            flipH: advRef(P.ADV_VIEWPORT_FLIP_H, () => executeCommand(P.ADV_VIEWPORT_FLIP_H)),
            flipV: advRef(P.ADV_VIEWPORT_FLIP_V, () => executeCommand(P.ADV_VIEWPORT_FLIP_V)),
            reset: advRef(P.ADV_VIEWPORT_RESET, () => executeCommand(P.ADV_VIEWPORT_RESET)),
          },
          translate: {
            fit: advRef(P.ADV_VIEWPORT_FIT, () => executeCommand(P.ADV_VIEWPORT_FIT)),
            actualSize: advRef(P.ADV_VIEWPORT_ACTUAL, () => executeCommand(P.ADV_VIEWPORT_ACTUAL)),
            zoom: advRef(P.ADV_VIEWPORT_ZOOM, (k: number) => executeCommand(P.ADV_VIEWPORT_ZOOM, k)),
          },
        },
        frame: {
          create: {
            trunk: advRef(P.ADV_FRAME_TRUNK, (payload: { source: File | string; switchFrame?: boolean; extra?: Record<string, unknown> }) => executeCommand<unknown, Promise<string>>(P.ADV_FRAME_TRUNK, payload)),
            branch: advRef(P.ADV_FRAME_BRANCH, () => executeCommand<void, Promise<string | null>>(P.ADV_FRAME_BRANCH)),
            revert: advRef(P.ADV_FRAME_REVERT, () => executeCommand(P.ADV_FRAME_REVERT)),
            remove: advRef(P.ADV_FRAME_REMOVE, (id?: string) => executeCommand(P.ADV_FRAME_REMOVE, id)),
            export: advRef(P.ADV_FRAME_EXPORT, (frame: Frame) => executeCommand<Frame, Promise<{ state: unknown; assets: Record<string, Blob> }>>(P.ADV_FRAME_EXPORT, frame)),
            import: advRef(P.ADV_FRAME_IMPORT, (payload: { state: unknown; assetBlobs: Record<string, Blob>; replaceId?: string; switchFrame?: boolean }) => executeCommand<unknown, Promise<Frame>>(P.ADV_FRAME_IMPORT, payload)),
          },
          resize: {
            resizeCanvas: advRef(P.ADV_FRAME_RESIZE_CANVAS, () => executeCommand(P.ADV_FRAME_RESIZE_CANVAS)),
            resample: advRef(P.ADV_FRAME_RESAMPLE, (payload: { targetDim: Dimensions }) => executeCommand<{ targetDim: Dimensions }, Promise<void>>(P.ADV_FRAME_RESAMPLE, payload)),
          },
        },
        layer: {
          toggle: {
            all: advRef(P.ADV_LAYER_TOGGLE_ALL, () => {
              const frameId = stateRef.current.activeFrameId;
              if (frameId) executeCommand(P.ADV_LAYER_TOGGLE_ALL, { frameId });
            }),
            others: advRef(P.ADV_LAYER_TOGGLE_OTHERS, (activeLayerId: string) => {
              const frameId = stateRef.current.activeFrameId;
              if (frameId) executeCommand(P.ADV_LAYER_TOGGLE_OTHERS, { frameId, activeLayerId });
            }),
          },
          clip: {
            cut: advRef(P.ADV_LAYER_CLIP_CUT, () => executeCommand(P.ADV_LAYER_CLIP_CUT)),
            copy: advRef(P.ADV_LAYER_CLIP_COPY, () => executeCommand(P.ADV_LAYER_CLIP_COPY)),
            paste: advRef(P.ADV_LAYER_CLIP_PASTE, (payload?: ClipboardLayerMetadata | { e?: ClipboardEvent } | undefined) => executeCommand(P.ADV_LAYER_CLIP_PASTE, payload)),
            drill: advRef(P.ADV_LAYER_CLIP_DRILL, () => executeCommand(P.ADV_LAYER_CLIP_DRILL)),
          },
          cmdj: {
            copy: advRef(P.ADV_LAYER_CMDJ_COPY, () => executeCommand(P.ADV_LAYER_CMDJ_COPY)),
            cut: advRef(P.ADV_LAYER_CMDJ_CUT, () => executeCommand(P.ADV_LAYER_CMDJ_CUT)),
          },
          peel: {
            peelToExchange: advRef(P.ADV_LAYER_PEEL_EXCHANGE, (payload: { isCopy: boolean }) => executeCommand(P.ADV_LAYER_PEEL_EXCHANGE, payload)),
          },
          mask: {
            toggle: advRef(P.ADV_LAYER_MASK_TOGGLE, (payload: { layerId: string; maskId: string; frameId?: string }) => executeCommand(P.ADV_LAYER_MASK_TOGGLE, payload)),
            invert: advRef(P.ADV_LAYER_MASK_INVERT, (payload: { layerId: string; frameId?: string }) => executeCommand(P.ADV_LAYER_MASK_INVERT, payload)),
            remove: advRef(P.ADV_LAYER_MASK_REMOVE, (payload: { layerId: string; maskId: string; frameId?: string }) => executeCommand(P.ADV_LAYER_MASK_REMOVE, payload)),
            clearAll: advRef(P.ADV_LAYER_MASK_CLEAR, (payload: { layerId: string; frameId?: string }) => executeCommand(P.ADV_LAYER_MASK_CLEAR, payload)),
          },
          bitmapMask: {
            add: advRef(P.ADV_LAYER_BITMAP_MASK_ADD, (payload: { frameId?: string; layerId: string; src: string; assetId: string; bounds: LocalShape['rect'] }) => executeCommand(P.ADV_LAYER_BITMAP_MASK_ADD, payload)),
            update: advRef(P.ADV_LAYER_BITMAP_MASK_UPDATE, (payload: { frameId?: string; layerId: string; maskId: string; patch: Partial<BitmapMask> }) => executeCommand(P.ADV_LAYER_BITMAP_MASK_UPDATE, payload)),
            toggle: advRef(P.ADV_LAYER_BITMAP_MASK_TOGGLE, (payload: { frameId?: string; layerId: string; maskId: string }) => executeCommand(P.ADV_LAYER_BITMAP_MASK_TOGGLE, payload)),
            remove: advRef(P.ADV_LAYER_BITMAP_MASK_REMOVE, (payload: { frameId?: string; layerId: string; maskId: string }) => executeCommand(P.ADV_LAYER_BITMAP_MASK_REMOVE, payload)),
            clearAll: advRef(P.ADV_LAYER_BITMAP_MASK_CLEAR, (payload: { frameId?: string; layerId: string }) => executeCommand(P.ADV_LAYER_BITMAP_MASK_CLEAR, payload)),
          },
          merge: {
            mergeHost: advRef(P.ADV_LAYER_MERGE_HOST, () => executeCommand(P.ADV_LAYER_MERGE_HOST)),
            down: advRef(P.ADV_LAYER_MERGE_DOWN, () => executeCommand(P.ADV_LAYER_MERGE_DOWN)),
            visible: advRef(P.ADV_LAYER_MERGE_VISIBLE, () => executeCommand(P.ADV_LAYER_MERGE_VISIBLE)),
            rasterize: advRef(P.ADV_LAYER_MERGE_RASTERIZE, (payload: { layerId?: string }) => executeCommand(P.ADV_LAYER_MERGE_RASTERIZE, payload)),
          },
        },
        system: {
          assets: {
            register: advRef(P.ADV_ASSET_REGISTER, (blob: Blob) => executeCommand<Blob, Promise<{ id: string; url: string }>>(P.ADV_ASSET_REGISTER, blob)),
            sync: advRef(P.ADV_ASSET_SYNC, (payload?: { force?: boolean }) => executeCommand(P.ADV_ASSET_SYNC, payload)),
          },
          engines: {
            probe: advRef(P.ADV_SYSTEM_PROBE_ENGINES, () => executeCommand(P.ADV_SYSTEM_PROBE_ENGINES)),
          },
        },
        irregular: {
          selection: {
            // Pre-PR-6-2: `set` / `clear` removed — producers (lasso / wand /
            // AI matting) call `actions.setIrregularCropBox(frameId, polygon | null)`
            // directly. See `phase1_irregular_clip_spec.md` §6 Pre-PR-6-2.0 / .1.
            toLayerMask: advRef(P.ADV_IRREGULAR_TO_LAYER_MASK, (payload?: { layerId?: string }) => executeCommand<{ layerId?: string } | undefined, Promise<void>>(P.ADV_IRREGULAR_TO_LAYER_MASK, payload)),
          },
        },
      }
    };

    const fastActions = {
      fast: {
        latestLayer: (frameId: string, id: string) => {
          const v = volatileRef.current;
          const frame = stateRef.current.frames.byId[frameId];
          const layer = frame?.layers.byId[id];
          if (!layer) return null;

          const compositeKey = LayerUtils.getCompositeKey(frameId, id);
          const draft = v.buffered.layers[compositeKey];
          return (v.activeState.interacting && draft) ? LayerUtils.mergeLayerDraft(layer, draft) : layer;
        },
        latestFrame: (id: string) => {
          const v = volatileRef.current;
          const frame = stateRef.current.frames.byId[id];
          if (!frame) return null;
          const draft = v.buffered.frames[id];
          return (v.activeState.interacting && draft) ? { ...frame, ...draft } : frame;
        },
        latestCamera: (id: string) => {
          const v = volatileRef.current;
          const frame = stateRef.current.frames.byId[id];
          if (!frame) return { x: 0, y: 0, k: 1 };
          const bufferedCamera = v.buffered.frames[id]?.camera;
          return (v.activeState.interacting && bufferedCamera) ? bufferedCamera : frame.camera;
        },
        isInteracting: () => volatileRef.current.activeState.interacting,
        getTransient: (key: string) => volatileRef.current.transient[key],
        setTransient: (key: string, data: unknown) => mutateVolatile(v => { v.transient[key] = data as Record<string, unknown>; }),
        override: (frameId: string, id: string, props: Record<string, unknown>, type: 'layer' | 'frame' | 'project' = 'layer') => {
          mutateVolatile(v => {
            if (type === 'layer') {
              const compositeKey = LayerUtils.getCompositeKey(frameId, id);
              v.buffered.layers[compositeKey] = { ...v.buffered.layers[compositeKey], ...props };
            } else if (type === 'frame') {
              v.buffered.frames[id] = { ...v.buffered.frames[id], ...props };
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
                enhancedDispatch({ type: 'BATCH_UPDATE_LAYER', payload: { frameId: fId, patches } });
              }
            });
          } else if (type === 'frames') {
            const patches = { ...v.buffered.frames };
            if (Object.keys(patches).length > 0) enhancedDispatch({ type: 'BATCH_UPDATE_FRAME', payload: { patches } });
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
                  enhancedDispatch({ type: 'UPDATE_LAYER', payload: { frameId: fId, layerId: id, patch: serializablePatch } });
                }
              }
            } else {
              const patch = v.buffered.frames[id];
              if (patch) enhancedDispatch({ type: 'UPDATE_FRAME', payload: { id, patch } });
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
          enhancedDispatch({ type: 'SIGNAL_COMMIT', payload: { frameId } });
        },
        reset: resetVolatile,
      }
    };

    return {
      executeCommand,
      ...frameActions,
      ...layerActions,
      ...uiActions,
      ...pluginActions,
      ...advActions,
      ...fastActions,
      updateStorageStats: () => { enhancedDispatch({ type: 'SET_STORAGE_USAGE', payload: { totalBytes: 0, blobCount: 0 } }); },
      setHistory: (history: GlobalHistoryState) => enhancedDispatch({ type: 'SET_HISTORY', payload: history }),
      resetHistory: () => enhancedDispatch({ type: 'HISTORY_RESET' }),
      replaceFrame: (frameId: string, frame: Frame) => enhancedDispatch({ type: 'REPLACE_FRAME', payload: { frameId, frame } }),
      history: {
        undo: () => enhancedDispatch({ type: 'HISTORY_UNDO' }),
        redo: () => enhancedDispatch({ type: 'HISTORY_REDO' }),
        purge: () => enhancedDispatch({ type: 'SET_HISTORY', payload: { past: [], future: [], checkpoint: null } }),
      },
      setEngineStatus: (statuses: EngineStatus[]) => enhancedDispatch({ type: 'SET_ENGINE_STATUS', payload: statuses }),
      clearAllData: () => { resetVolatile(); enhancedDispatch({ type: 'CLEAR_ALL_DATA' }); },
      mutateVolatile,
      updateVolatile,
      commitVolatile,
      resetVolatile,
    };
  }, [enhancedDispatch, mutateVolatile, updateVolatile, commitVolatile, resetVolatile, volatileRef]);

  // --- 5. State Synchronization and Facade ---
  const activeFrame = useMemo<Frame | null>(() =>
    state.activeFrameId ? state.frames.byId[state.activeFrameId] || null : null,
    [state.frames, state.activeFrameId]
  );

  const activeLayer = useMemo<Layer | null>(() =>
    (activeFrame && activeFrame.activeLayerId) ? activeFrame.layers.byId[activeFrame.activeLayerId] || null : null,
    [activeFrame]
  );

  const stateFacade = useMemo<EditorState>(() => ({
    ...state,
    getStateSignal: <T = boolean>(key: string, defaultValue?: T): T => {
      const val = state.interaction.signals[key];
      return (val !== undefined ? val : (defaultValue ?? (false as unknown as T))) as T;
    }
  }), [state]);

  useEffect(() => {
    stateRef.current = state;
    frameRef.current = activeFrame;
    layerRef.current = activeLayer;
  }, [state, activeFrame, activeLayer]);

  // --- 6. HUD Message Sentinel ---
  // Enterprise design: Automatically manage the lifecycle of HUD, preventing messages from being "deadlocked" on the interface due to parallel operations or logical competition.
  useEffect(() => {
    if (state.interaction.hud) {
      const timer = setTimeout(() => {
        actions.setInteraction({ hud: null });
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [state.interaction.hud, actions]);

  // Exposed interface
  return {
    state: stateFacade,
    dispatch: enhancedDispatch,
    actions,
    activeFrame,
    activeLayer,
    volatileRef,
    contextValueRef, // Used in index.tsx to mount contextValue
    isHydrated,      // Used in index.tsx for state synchronization
  };
}
