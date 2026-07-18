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

/**
 * State Types: Pure data state definitions (excluding behavioral logic)
 */
import { Frame, Layer, CameraState, NormalizedState } from './models';
import { Dimensions, SmartGuideData } from './geometry';
import { LocalShape, LocalPolygon } from './primitives';
import { Patch } from 'immer';

export type CoreEditorSlot = 'TL' | 'TR' | 'BL' | 'BR' | 'DOCK' | 'SIDE_BAR' | 'ROOT_OVERLAY' | 'VIEWPORT_OVERLAY' | 'STAGE_OVERLAY' | 'STAGE_GIZMOS' | 'OPTION_BAR' | 'TOOL_MENU' | 'HIDDEN';
export type EditorSlot = CoreEditorSlot | (string & {});
export type AppearanceMode = 'light' | 'dark' | 'system';

export interface WorkspaceThemeState {
  active: string;
  config: {
    insets: {
      top: number;
      bottom: number;
      fixed: { left: number; right: number };
      varied: { left: number; right: number };
    };
  };
}

export type InteractionSignalValue = string | number | boolean | null | { [key: string]: unknown } | unknown[];

export type InteractionMode = 'pan' | 'clip' | 'craft' | (string & {});

export interface InteractionState {
  isInteracting: boolean;
  isSnapping: boolean;
  hoveredLayerId?: string | null;
  isHoveringActiveLayer?: boolean;
  interactionMode: InteractionMode;
  selectionErrorPulse?: number;
  smartguides: SmartGuideData | null;
  hud?: {
    message: string;
    type: 'info' | 'success' | 'error';
  } | null;
  signals: Record<string, InteractionSignalValue>;
  /** Cursor override value that plugin can set (null = use default logic) */
  cursorOverride: string | null;
}

export interface UIConfig {
  viewportDim: Dimensions;

  theme: WorkspaceThemeState;
  appearance: AppearanceMode;
  activeSidebarIds: string[];
  sidebarOrder: Record<'left' | 'right', string[]>;
  sidebarMode: 'DOCKED' | 'FLOATING';
  isToolMenuPinned?: boolean;

}

export type SupportedImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' | 'avif' | 'svg' | 'eps' | 'bmp' | 'raw' | 'unknown';

export interface EngineStatus {
  id: string;
  name: string;
  status: 'ready' | 'loading' | 'error' | 'unimplemented';
  version?: string;
}

export interface EditorData {
  frames: NormalizedState<Frame>;
  activeFrameId: string | null;
  pluginConfig: Record<string, Record<string, unknown>>;
  ui: UIConfig;
  isLoaded: boolean;
  storageUsage?: { totalBytes: number; blobCount: number };
  confirm: { isVisible: boolean; title: string; message: string; type?: 'info' | 'danger' | 'warning'; variant?: 'square' | 'rect' } | null;
  choice: { isVisible: boolean; title: string; options: Array<{ id: string; label: string; description?: string; icon?: string; iconGradient?: string; primary?: boolean }>; helpText?: string } | null;
  interaction: InteractionState;
  history: GlobalHistoryState;
  runtime: {
    engineStatuses: EngineStatus[];
  };
}

export interface EditorState extends EditorData {
  getStateSignal: <T = boolean>(key: string, defaultValue?: T) => T;
}

export interface HistoryStep {
  id: string;
  name: string;
  undoPatches: Patch[];
  redoPatches: Patch[];
}

/** Single frame's independent history stack */
export interface FrameHistoryState {
  past: HistoryStep[];
  future: HistoryStep[];
  /** Snapshot of the frame at last commit — used to diff against current state */
  checkpoint: Frame | null;
}

/** Global history container: per-frame map keyed by frameId */
export interface GlobalHistoryState {
  byFrameId: Record<string, FrameHistoryState>;
}

export type EditorAction =
  | { type: 'SET_LOADED'; payload: boolean }
  | { type: 'ADD_FRAME'; payload: { frame: Frame; switchFrame?: boolean } }
  | { type: 'SWITCH_FRAME'; payload: string }
  | { type: 'UPDATE_FRAME'; payload: { id: string; patch: Partial<Frame> } }
  | { type: 'BATCH_UPDATE_FRAME'; payload: { patches: Record<string, Partial<Frame>> } }
  | { type: 'REMOVE_FRAME'; payload: { frameIds: string[]; nextActiveFrameId: string | null } }
  | { type: 'REORDER_FRAMES'; payload: { oldIndex: number; newIndex: number } }
  | { type: 'ADD_LAYER'; payload: { frameId: string; layers: Layer[]; index?: number } }
  | { type: 'UPDATE_LAYER'; payload: { frameId: string; layerId: string; patch: Partial<Layer> } }
  | { type: 'BATCH_UPDATE_LAYER'; payload: { frameId: string; patches: Record<string, Partial<Layer>> } }
  | { type: 'REMOVE_LAYERS'; payload: { frameId: string; layerIds: string[]; nextActiveLayerId?: string | null } }
  | { type: 'REORDER_LAYERS'; payload: { frameId: string; oldIndex: number; newIndex: number } }
  | { type: 'SET_LAYERS'; payload: { frameId: string; layers: Layer[] } }
  | { type: 'SET_ACTIVE_LAYER'; payload: { frameId: string; layerId: string | null } }
  | { type: 'UPDATE_CAMERA'; payload: { frameId: string; camera: CameraState } }
  | { type: 'SET_CLIP_BOX'; payload: { frameId: string; toolId: string; value: LocalPolygon | null } }
  | { type: 'SET_CANVAS_CROP_BOX'; payload: { frameId: string; cropBox: LocalShape } }

  | { type: 'SET_IMAGE_ASPECT'; payload: { frameId: string; aspect: number | undefined } }
  | { type: 'SET_CANVAS_ASPECT'; payload: { frameId: string; aspect: number | undefined } }
  | { type: 'SIGNAL_COMMIT'; payload: { frameId: string } }
  | { type: 'UPDATE_PLUGIN_CONFIG'; payload: { pluginId: string; patch: Record<string, unknown> } }
  | { type: 'INIT_PLUGIN_CONFIG'; payload: { pluginId: string; initialConfig: Record<string, unknown> } }
  | { type: 'SET_VIEWPORT_DIM'; payload: { w: number; h: number } }
  | { type: 'UPDATE_UI'; payload: Partial<UIConfig> }
  | { type: 'HYDRATE'; payload: Partial<EditorState> }
  | { type: 'SHOW_CONFIRM'; payload: { title: string; message: string; type?: 'info' | 'danger' | 'warning'; variant?: 'square' | 'rect' } }
  | { type: 'HIDE_CONFIRM' }
  | { type: 'SHOW_CHOICE'; payload: { title: string; options: Array<{ id: string; label: string; description?: string; icon?: string; iconGradient?: string; primary?: boolean }>; helpText?: string } }
  | { type: 'HIDE_CHOICE' }
  | { type: 'UPDATE_VIEW_SIZE'; payload: { w: number; h: number } }
  | { type: 'SET_ENGINE_STATUS'; payload: EngineStatus[] }
  | { type: 'SET_INTERACTION'; payload: Partial<InteractionState> }
  | { type: 'TOGGLE_INTERACTION_SIGNAL'; payload: string }
  | { type: 'CLEAR_ALL_DATA' }
  | { type: 'SET_STORAGE_USAGE'; payload: { totalBytes: number; blobCount: number } }
  | { type: 'SET_FRAMES'; payload: NormalizedState<Frame> }
  | { type: 'SET_HISTORY'; payload: GlobalHistoryState }
  | { type: 'HISTORY_UNDO' }
  | { type: 'HISTORY_REDO' }
  | { type: 'HISTORY_RESET' }
  | { type: 'REPLACE_FRAME'; payload: { frameId: string; frame: Frame } };

/**
 * VolatileInteraction: High-frequency interaction transient data.
 * Lives in the fast-track (volatileRef), NOT in the Reducer state.
 * Does not trigger React re-renders when mutated.
 * 
 * @see docs/opengpex/20260630_interaction_state_volatile_migration_spec.md
 */
export interface VolatileInteraction {
  /** Currently hovered layer ID (null = no hover) */
  hoveredLayerId: string | null;
  /** Whether the cursor is hovering the active (selected) layer */
  isHoveringActiveLayer: boolean;
  /** Cursor override value set by plugins/tools (null = use default logic) */
  cursorOverride: string | null;
  /** HUD toast message (null = no message) */
  hud: { message: string; type: 'info' | 'success' | 'error' } | null;
  /** Smart guide alignment data during interactions */
  smartguides: SmartGuideData | null;
  /** Selection error pulse counter */
  selectionErrorPulse: number;
}

export interface VolatileState {
  /** Synthesized active state signal */
  activeState: {
    interacting: boolean;
  };

  /** Entity attributes buffer layer (shadow overlap) */
  buffered: {
    layers: Record<string, Partial<Layer> & {
      imageOverride?: CanvasImageSource;
      bitmapMaskOverride?: { maskId: string; source: CanvasImageSource };
    }>;
    frames: Record<string, Partial<Frame>>;
    project: Partial<EditorData>;
  };

  /** Transient data container for plugins and features */
  transient: Record<string, Record<string, unknown>>;

  /** High-frequency interaction transient store (fast-track, not reactive) */
  interaction: VolatileInteraction;
}
export interface VolatileStateHandle {
  volatileRef: React.RefObject<VolatileState>;
  mutate: (mutator: (v: VolatileState) => void) => void;
  update: (patch: Partial<VolatileState>) => void;
  commit: () => void;
  reset: () => void;
}
