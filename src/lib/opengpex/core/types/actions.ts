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

import { Frame, Layer, CameraState, NormalizedState, BitmapMask } from './models';
import { Dimensions, LocalShape, LocalRect, LocalPolygon } from './primitives';
import { VolatileState, InteractionState, UIConfig, GlobalHistoryState, InteractionSignalValue } from './state';
import { BuiltCommand, EditorShortcut, BuiltPlugin } from './plugins';
import {
  ClipboardLayerMetadata,
  FrameExportResult,
  FrameUnpackPayload,
  FrameExportEncodePayload,
  FrameExportEncodeResult,
} from './services';

/**
 * AdvCommandRef: Rich reference object for advanced commands
 * Carries both execution capability and command metadata (id, name, shortcut label),
 * allowing plugins to get the full view of the command without importing additional protocol constants.
 *
 * Each `execute` function also exposes a `.noundo(...)` variant that suppresses
 * the pre-execution SIGNAL_COMMIT checkpoint. Use `.noundo()` when invoking a
 * command inside an interaction transaction whose undo boundary is already owned
 * by a parent gesture (e.g. peel commit/cancel within the peel session).
 */
export interface AdvCommandRef<TPayload = void, TReturn = void> {
  readonly id: string;
  readonly name: string;
  readonly shortcutLabel: string;
  execute: ([TPayload] extends [void] ? () => TReturn : (payload: TPayload) => TReturn) & {
    /** Execute without generating an undo checkpoint (suppress SIGNAL_COMMIT). */
    noundo: [TPayload] extends [void] ? () => TReturn : (payload: TPayload) => TReturn;
  };
}

export interface ChoiceSwitchConfig {
  label: string;
  description?: string;
  defaultValue?: boolean;
}

export interface ChoiceResult {
  id: string;
  switchValue?: boolean;
}

/**
 * ONE record write inside an `adv.layer.bitmapMask.applyBatch` payload —
 * the single-undoable-unit multi-record bake of an eraser/restore stroke
 * (the erase record + every hole-filled restore record). Mirrors the
 * command's `BitmapMaskBatchOp` (declared beside the command to keep the
 * types layer free of command imports).
 */
export interface BitmapMaskBatchOpPayload {
  /** APPLY semantics: land on the record `maskId` points at; create + adopt when absent. */
  kind: 'apply';
  /**
   * Target record id — the session's transient id for a brand-new record
   * (adopted as the record's permanent id when free) or an existing record's
   * id (rewritten in place). Membership at execute time decides which.
   */
  maskId?: string;
  src: string;
  assetId: string;
  bounds: LocalRect;
  /** HARD mask edge; `false`/omitted clears a stale `hard: true` (patch spread). */
  hard?: boolean;
  /** Family (erase family when omitted); only written when the op creates a record. */
  inverted?: boolean;
  /** Marks the record as having received stamps (see `BitmapMask.painted`). */
  painted?: boolean;
}

/** 
 * EditorActions: Editor core actions API surface
 * Defines all commands that can change the editor state or trigger behaviors.
 */
export interface EditorActions {
  addFrame: (frame: Frame, switchFrame?: boolean) => void;
  switchFrame: (id: string) => void;
  updateFrame: (id: string, patch: Partial<Frame>) => void;
  removeFrame: (frameIds: string[], nextActiveFrameId: string | null) => void;
  reorderFrames: (oldIndex: number, newIndex: number) => void;
  setFrames: (frames: Frame[] | NormalizedState<Frame>) => void;

  addLayers: (frameId: string, layers: Layer[], index?: number) => void;
  updateLayer: (frameId: string, layerId: string, patch: Partial<Layer>) => void;
  batchUpdateLayers: (frameId: string, patches: Record<string, Partial<Layer>>) => void;
  removeLayers: (frameId: string, layerIds: string[], nextActiveLayerId?: string | null) => void;
  reorderLayers: (frameId: string, oldIndex: number, newIndex: number) => void;
  setLayers: (frameId: string, layers: Layer[]) => void;
  setActiveLayer: (frameId: string, layerId: string | null) => void;

  updateCamera: (frameId: string, camera: CameraState) => void;
  /**
   * Sets or clears a clip selection slot for a specific tool.
   *
   * @param frameId     Target frame.
   * @param clipToolId  Producing tool id (e.g. `'rect'`, `'ellipse'`, `'lasso'`, `'wand'`).
   *                    Each tool has its own slot in `Frame.clipBoxes`.
   * @param value       The selection to store (LocalShape for rect/ellipse,
   *                    LocalPolygon for lasso/wand), or `null` to clear the slot.
   */
  setClipBox: (frameId: string, clipToolId: string, value: LocalPolygon | null) => void;
  setCanvasClipBox: (frameId: string, clipBox: LocalShape) => void;

  setImageAspect: (frameId: string, aspect: number | undefined) => void;
  setCanvasAspect: (frameId: string, aspect: number | undefined) => void;

  updateUI: (patch: Partial<UIConfig>) => void;
  updateViewSize: (size: { w: number; h: number }) => void;
  setInteraction: (patch: Partial<InteractionState>) => void;
  setStateSignal: (key: string, value: InteractionSignalValue) => void;
  toggleStateSignal: (key: string) => void;
  withSignal: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  notifyHUD: (message: string, type?: 'info' | 'success' | 'error') => void;

  executeCommand: <P = unknown, R = unknown>(id: string, payload?: P) => R;

  registerShortcut: (shortcut: EditorShortcut) => void;
  unregisterShortcut: (id: string) => void;
  registerCommand: (command: BuiltCommand) => void;
  registerPlugin: (plugin: BuiltPlugin) => void;
  unregisterPlugin: (id: string) => void;
  updatePluginConfig: (pluginId: string, patch: Record<string, unknown>) => void;
  getPluginConfig: (pluginId: string) => Record<string, unknown> | undefined;

  // --- Standard Semantic Operations ---
  askConfirm: (title: string, message: string, type?: 'info' | 'danger' | 'warning', variant?: 'square' | 'rect') => Promise<boolean>;
  confirm: (val: boolean) => void;
  askChoice: {
    (
      title: string,
      options: Array<{ id: string; label: string; description?: string; icon?: string; iconGradient?: string; primary?: boolean }>,
      helpText?: string,
    ): Promise<string | null>;
    (
      title: string,
      options: Array<{ id: string; label: string; description?: string; icon?: string; iconGradient?: string; primary?: boolean }>,
      helpText: string | undefined,
      switchConfig: ChoiceSwitchConfig,
    ): Promise<ChoiceResult | null>;
  };
  resolveChoice: (val: string | ChoiceResult | null) => void;

  clearAllData: () => void;
  updateStorageStats: () => void;
  setHistory: (history: GlobalHistoryState) => void;
  resetHistory: () => void;
  replaceFrame: (frameId: string, frame: Frame) => void;

  history: {
    undo: () => void;
    redo: () => void;
    purge: () => void;
    canUndo: () => boolean;
    canRedo: () => boolean;
  };

  adv: {
    viewport: {
      transform: {
        rotate: AdvCommandRef<{ direction: 'left' | 'right' }>;
        rotateLeft: AdvCommandRef;
        rotateRight: AdvCommandRef;
        flip: AdvCommandRef<{ direction: 'horizontal' | 'vertical' }>;
        flipH: AdvCommandRef;
        flipV: AdvCommandRef;
        reset: AdvCommandRef;
      };
      translate: {
        fit: AdvCommandRef;
        actualSize: AdvCommandRef;
        zoom: AdvCommandRef<number>;
      };
    };
    gpex: {
      pack: AdvCommandRef<Frame, Promise<FrameExportResult>>;
      unpack: AdvCommandRef<FrameUnpackPayload, Promise<Frame>>;
    };
    frame: {
      create: {
        trunk: AdvCommandRef<{ source: File | string; switchFrame?: boolean; extra?: Record<string, unknown> }, Promise<string>>;
        branch: {
          fromFile: AdvCommandRef<{ source: File; extra?: Record<string, unknown> }, Promise<string | undefined>>;
          fromSelection: AdvCommandRef<void, Promise<string | undefined>>;
        };
      };
      revert: AdvCommandRef;
      remove: AdvCommandRef<string | undefined>;
      gpex: {
        pack: AdvCommandRef<Frame, Promise<FrameExportResult>>;
        unpack: AdvCommandRef<FrameUnpackPayload, Promise<Frame>>;
      };
      export: {
        encode: AdvCommandRef<FrameExportEncodePayload, Promise<FrameExportEncodeResult>>;
      };
      resize: {
        resizeCanvas: AdvCommandRef;
        resample: AdvCommandRef<{ targetDim: Dimensions; dpi?: number }, Promise<void>>;
        replace: AdvCommandRef<{ source: File; dpi?: number }, Promise<void>>;
      };
    };
    layer: {
      toggle: {
        all: AdvCommandRef;
        others: AdvCommandRef<string>;
      };
      clip: {
        cut: AdvCommandRef;
        copy: AdvCommandRef;
        paste: AdvCommandRef<ClipboardLayerMetadata | { e?: ClipboardEvent } | undefined>;
        drill: AdvCommandRef<{ feather?: number } | undefined>;
        toMask: AdvCommandRef<{ layerId?: string; feather?: number } | undefined, Promise<void>>;
      };
      cmdj: {
        copy: AdvCommandRef<{ feather?: number } | undefined>;
        cut: AdvCommandRef<{ feather?: number } | undefined>;
      };
      peel: {
        peelToExchange: AdvCommandRef<{ isCopy: boolean }>;
        discardExchange: AdvCommandRef;
      };
      mask: {
        toggle: AdvCommandRef<{ layerId: string; maskId: string; frameId?: string }>;
        invert: AdvCommandRef<{ layerId: string; frameId?: string }>;
        remove: AdvCommandRef<{ layerId: string; maskId: string; frameId?: string }>;
        clearAll: AdvCommandRef<{ layerId: string; frameId?: string }>;
      };
      bitmapMask: {
        add: AdvCommandRef<{ frameId?: string; layerId: string; src: string; assetId: string; bounds: LocalRect; hard?: boolean; inverted?: boolean; painted?: boolean }>;
        update: AdvCommandRef<{ frameId?: string; layerId: string; maskId: string; patch: Partial<BitmapMask> }>;
        applyBatch: AdvCommandRef<{ frameId?: string; layerId: string; ops: BitmapMaskBatchOpPayload[] }>;
        toggle: AdvCommandRef<{ frameId?: string; layerId: string; maskId: string }>;
        remove: AdvCommandRef<{ frameId?: string; layerId: string; maskId: string }>;
        clearAll: AdvCommandRef<{ frameId?: string; layerId: string }>;
      };
      merge: {
        mergeHost: AdvCommandRef;
        down: AdvCommandRef;
        visible: AdvCommandRef;
        rasterize: AdvCommandRef<{ layerId?: string }>;
      };
    };
    system: {
      assets: {
        sync: AdvCommandRef<{ force?: boolean } | undefined>;
      };
    };

  };

  fast: {
    /**
     * @deprecated Do not directly call the underlying high-frequency override API. Direct use easily triggers memory leaks or infinite loops.
     * Plug-in developers should use the upper-level wrapped `InteractionTransaction` class for high-frequency state synchronization during interactions.
     */
    override: (frameId: string, id: string, props: Record<string, unknown>, type?: 'layer' | 'frame' | 'project') => void;
    latestLayer: (frameId: string, id: string) => Layer | null;
    latestFrame: (id: string) => Frame | null;
    latestCamera: (id: string) => CameraState;
    isInteracting: () => boolean;
    getTransient: (key: string) => Record<string, unknown> | undefined;
    setTransient: (key: string, data: unknown) => void;
    /**
     * @deprecated Do not directly call the underlying commit API. Missing calls or incorrect arguments will lead to severe performance issues (e.g. 60FPS full-load redraws).
     * Please use `InteractionTransaction`.
     */
    commit: (id?: string | null, type?: 'layer' | 'layers' | 'frame' | 'frames' | 'project') => void;
    signal: (frameId: string) => void;
    reset: () => void;

    // ─── Volatile Interaction (high-frequency transient state) ─────────
    /** Set cursor override (null = use default logic) */
    setCursor: (cursor: string | null) => void;
    /** Get current cursor override */
    getCursor: () => string | null;
    /** Set hovered layer */
    setHover: (layerId: string | null, isHoveringActive?: boolean) => void;
    /** Subscribe to a volatile interaction field change. Returns unsubscribe function. */
    subscribeInteraction: (key: string, listener: () => void) => () => void;
  };

  mutateVolatile: (mutator: (v: VolatileState) => void) => void;
  updateVolatile: (patch: Partial<VolatileState>) => void;
  commitVolatile: () => void;
  resetVolatile: () => void;
}
