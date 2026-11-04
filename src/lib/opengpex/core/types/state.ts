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
import { LocalShape } from './primitives';
import { SpringChannel } from './plugins';
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
  hoveredLayerId?: string | null;
  isHoveringActiveLayer?: boolean;
  interactionMode: InteractionMode;
  hud?: {
    message: string;
    type: 'info' | 'success' | 'error';
    subtitle?: string;
    duration?: number;
  } | null;
  signals: Record<string, InteractionSignalValue>;
}

export interface UIConfig {
  viewportDim: Dimensions;

  theme: WorkspaceThemeState;
  appearance: AppearanceMode;
  activeSidebarIds: string[];
  sidebarOrder: Record<'left' | 'right', string[]>;
  sidebarMode: 'DOCKED' | 'FLOATING';
  isToolMenuPinned?: boolean;
  /**
   * Width mode for the floating drawer panels that do NOT declare their own
   * `preferredWidth`. 'normal' falls back to 320px; 'compact' falls back to
   * 280px. Plugin-declared widths are never overridden by this setting.
   */
  drawerWidthMode?: 'normal' | 'compact';

}

export type SupportedImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' | 'avif' | 'svg' | 'eps' | 'bmp' | 'raw' | 'unknown';


export interface EditorData {
  frames: NormalizedState<Frame>;
  activeFrameId: string | null;
  pluginConfig: Record<string, Record<string, unknown>>;
  ui: UIConfig;
  isLoaded: boolean;
  storageUsage?: { totalBytes: number; blobCount: number };
  confirm: { isVisible: boolean; title: string; message: string; type?: 'info' | 'danger' | 'warning'; variant?: 'square' | 'rect' } | null;
  choice: { isVisible: boolean; title: string; options: Array<{ id: string; label: string; description?: string; icon?: string; iconGradient?: string; primary?: boolean }>; helpText?: string; switchConfig?: { label: string; description?: string; defaultValue?: boolean } } | null;
  interaction: InteractionState;
  history: GlobalHistoryState;
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
  | { type: 'SET_CANVAS_CLIP_BOX'; payload: { frameId: string; clipBox: LocalShape } }

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
  | { type: 'SHOW_CHOICE'; payload: { title: string; options: Array<{ id: string; label: string; description?: string; icon?: string; iconGradient?: string; primary?: boolean }>; helpText?: string; switchConfig?: { label: string; description?: string; defaultValue?: boolean } } }
  | { type: 'HIDE_CHOICE' }
  | { type: 'UPDATE_VIEW_SIZE'; payload: { w: number; h: number } }
  | { type: 'SET_INTERACTION'; payload: Partial<InteractionState> }
  | { type: 'TOGGLE_INTERACTION_SIGNAL'; payload: string }
  | { type: 'CLEAR_ALL_DATA' }
  | { type: 'SET_STORAGE_USAGE'; payload: { totalBytes: number; blobCount: number } }
  | { type: 'SET_FRAMES'; payload: NormalizedState<Frame> }
  | { type: 'SET_HISTORY'; payload: GlobalHistoryState }
  | { type: 'HISTORY_UNDO' }
  | { type: 'HISTORY_REDO' }
  | { type: 'HISTORY_RESET' }
  | { type: 'HISTORY_TRUNCATE'; payload: { frameId: string; pastLength: number } }
  | { type: 'REPLACE_FRAME'; payload: { frameId: string; frame: Frame } };

/**
 * VolatileInteraction: High-frequency interaction transient data.
 * Lives in the fast-track (volatileRef), NOT in the Reducer state.
 * Does not trigger React re-renders when mutated.
 * 
 */
export interface VolatileInteraction {
  /** Currently hovered layer ID (null = no hover) */
  hoveredLayerId: string | null;
  /** Whether the cursor is hovering the active (selected) layer */
  isHoveringActiveLayer: boolean;
  /** THE cursor output — the single resolved value the viewport (and
   * element-level consumers) display. Computed by the cursor service from
   * the inputs below; never written by plugins directly. */
  resolvedCursor: string | null;
  /** The resolved cursor WHEN it carries global (object-manipulation)
   * semantics — move/grab/grabbing — else null. Elements that own a base
   * cursor of their own (e.g. a contenteditable's 'text' caret) yield to
   * this value and keep their base otherwise; the global-family policy
   * lives here in the service, not at the element. */
  globalCursor: string | null;
  /** Per-channel spring key engagement (the channel's physical key held,
   * not suppressed). `meta` is the only channel with semantics attached
   * today (cursor priority + press routing); `alt` / `shift` are reserved
   * for future spring channels. */
  springChannels: Record<SpringChannel, boolean>;
  /** Spring key suppression: a modal context (e.g. Re-Canvas) claims every
   * press and must not be overridden by the spring key — while true the
   * cursor service skips the spring priority and the dispatcher routes
   * Cmd+drag as a bare drag. */
  springSuppressed: boolean;
  /** HUD toast message (null = no message) */
  hud: { message: string; type: 'info' | 'success' | 'error'; subtitle?: string } | null;
  /** Smart guide alignment data during interactions */
  smartguides: SmartGuideData | null;
}

/**
 * ONE live eraser/restore mask preview record — the mid-stroke scratch that
 * replaces that record's baked copy in the composited scene.
 *
 * `bounds` is the layer-local ORIGIN the mask canvas is anchored to (see
 * `LayerUtils.getMaskOrigin`). It must match the `BitmapMask.bounds.x/y`
 * that the subsequent bake writes, otherwise the preview and the committed
 * result would disagree ("preview right, landing wrong"). Omitted / (0,0)
 * for regular full-layer images.
 *
 * `hard` mirrors the `BitmapMask.hard` the bake will persist (same
 * "preview == landing" contract as `bounds`): threshold the sampled mask
 * alpha at 0.5 for a binary edge. Omitted = soft.
 *
 * `inverted` mirrors the `BitmapMask.inverted` the bake will persist (same
 * contract): the record's FAMILY in the two-family combine — `false` (omit)
 * = erase family (alpha into the product), `true` = restore family (`1 − α`
 * into the max). The combine pass must sample the live scratch with the same
 * family semantics the baked record will get, or the preview and the landing
 * would disagree.
 */
export interface BitmapMaskOverrideEntry {
  source: ImageBitmap | OffscreenCanvas;
  bounds?: { x: number; y: number };
  version?: number;
  hard?: boolean;
  inverted?: boolean;
}

/**
 * Live bmask preview records of ONE layer, keyed by `maskId`. Multi-slot by
 * design: a single stroke may drive several records at once (the restore
 * architecture's "erase a hole into every active restore record" op), so the
 * assembler replaces EACH keyed record's baked source with its live scratch
 * while the remaining records keep their baked textures. The dispatched map
 * is the session's FULL live set — it replaces the previous map wholesale.
 * A key may reference a record that does not exist in `layer.bitmapMasks`
 * yet (a brand-new record mid-stroke, baked as an add at stroke end).
 */
export type BitmapMaskOverrideMap = Record<string, BitmapMaskOverrideEntry>;

/**
 * A per-gesture fast-track draft for one layer (keyed `frameId:layerId` in
 * `VolatileState.buffered.layers`). Split by LANDING semantics — the only
 * data-level distinction the bag has:
 *
 *   • `patch`  — Layer fields streamed by the live gesture, LANDED onto the
 *     Layer when the transaction commits (pose during a move, `adjustments`
 *     during a slider drag, `strokeData`/`markerData` during vector drawing).
 *   • `mask`   — live eraser/restore mask preview, keyed by `maskId`; NEVER
 *     landed via the draft merge (the eraser bakes through its own commit
 *     path). See {@link BitmapMaskOverrideMap} / {@link BitmapMaskOverrideEntry}
 *     for the per-record "preview == landing" contracts.
 *
 * `useIncreComp` is a WRITER DECLARATION, not a layer property: the gesture
 * session that redefines a vector source (brush stroke / marker shape) opts in
 * once at transaction open, declaring "my updates are per-frame churn — run
 * Incremental Compositing for me". It is a request, not a promise: engagement
 * is still gated (topmost layer, ≥2 layers, below-stack signature match). The
 * probe reads this declaration instead of sniffing payload field names, so the
 * engine never needs to know which tools exist. Gestures are exclusive and
 * drafts are cleared at commit/abort, so `patch` and `mask` never coexist on
 * one draft in practice.
 */
export interface LayerDraft {
  /** Landing patch — see the interface doc. */
  patch?: Partial<Layer>;
  /** Writer declaration: opt this gesture into Incremental Compositing. */
  useIncreComp?: boolean;
  /** Live mask preview — see the interface doc. */
  mask?: BitmapMaskOverrideMap;
}

/**
 * TransformLayer — live payload of an in-flight FRAGMENT scale gesture
 * (peel exchange — key `fragmentTransform` in `VolatileState.transient`).
 *
 * The gesture lands cx/cy/rotation through the regular buffered layer patch
 * (real Layer fields the merge already streams), but the magnification has NO
 * Layer field to ride (`Layer.scale` is deprecated and must not gain
 * rendering semantics), so it lives here and reaches the renderer through
 * SceneAssembler's `getLayerPoseOverride` seam — recomputed every frame,
 * never cached, never part of a composite signature. The bake command reads
 * the same payload to render the final composite, so the baked pixels are
 * the exact ones the preview showed.
 */
export interface TransformLayer {
  /** The layer being transformed (the peel exchange id). */
  layerId: string;
  /**
   * The asset the gesture is magnifying. The overlay applies ONLY while the
   * layer still renders this asset: once the bake swaps the layer onto its
   * new (already magnified) asset, the overlay stands down by itself, so the
   * hand-over from preview to baked pixels can never double-scale a frame.
   */
  sourceAssetId?: string;
  /** Per-axis magnification relative to the gesture-start pose. */
  scaleX: number;
  scaleY: number;
  /**
   * sourceAngle slots (degrees): the preview linear part composes
   * `O(rotationDeg) · diag(scaleX, scaleY) · R(−sourceAngle)`. sourceAngle
   * is the content's tilt inside the bitmap (left by earlier peel bakes);
   * cancelling it BEFORE the stretch lets the factors scale along the
   * content's own axes. Both slots ride together; absent (→ bare `O·S`)
   * when the tilt is 0.
   */
  rotationDeg?: number;
  sourceAngle?: number;
}

/**
 * Declarative gesture-feedback record for the system-level displacement
 * label (key `gestureFeedback` in `VolatileState.transient`). A gesture
 * that moves or rotates an entity DECLARES what it is moving and where it
 * started; the shared delta label widget reads this record and renders one
 * `→ dx ↓ dy` / `↻ angle` chip. The declaration rides the gesture's
 * InteractionTransaction, so commit/abort clear it with the rest of the
 * volatile state — no per-handler cleanup and no cross-plugin sniffing of
 * who is moving what.
 */
export interface InteractionGestureFeedback {
  /** Translate shows the entity's displacement; rotate shows its live absolute angle. */
  kind: 'translate' | 'rotate';
  /** Which entity the delta is measured against. */
  target: 'frame' | 'layer';
  /** Layer id when `target` is 'layer' (the merged frame resolves the live pose). */
  targetId?: string;
  /**
   * Gesture-start reference of the moved entity: for 'frame' the selection
   * rect's top-left, for 'layer' the layer's (cx, cy). The widget subtracts
   * it from the live value every frame.
   */
  origin: { x: number; y: number };
  /**
   * Overrides the widget's default chip clearance below the (live-derived)
   * anchor. The default exists to clear a co-located label — e.g. the frame
   * chip's 24px reserves space for the dimension label sharing the
   * selection's corner — but that label is mode-dependent (never shows in
   * pan), so the pan selection move declares a tighter clearance instead of
   * leaving the label slot empty. The anchor itself is still derived from
   * the LIVE entity every frame; only the clearance is overridden.
   */
  anchorOffsetY?: number;
}

export interface VolatileState {
  /** Synthesized active state signal */
  activeState: {
    interacting: boolean;
  };

  /** Entity attributes buffer layer (shadow overlap) */
  buffered: {
    layers: Record<string, LayerDraft>;
    frames: Record<string, Partial<Frame>>;
    project: Partial<EditorData>;
  };

  /** Transient data container for plugins and features */
  transient: Record<string, Record<string, unknown>>;

  /** High-frequency interaction transient store (fast-track, not reactive) */
  interaction: VolatileInteraction;

  /**
   * @internal [Perf] Buffer write version counter.
   * Incremented on every `fast.override` write to buffered.layers or buffered.frames.
   * Used by useFastSync snapshot cache to detect staleness without Object.keys().
   */
  _bufferVersion: number;

  /**
   * @internal [Perf] Per-tick merged frame snapshot cache.
   * Computed once by the first useFastSync subscriber in each tick,
   * shared by all subsequent subscribers in the same tick.
   */
  _snapshot?: {
    /** Buffer version when this snapshot was computed */
    version: number;
    /** Source frame reference (React state) — invalidates on state update */
    sourceFrame: Frame;
    /** Merged frame result */
    frame: Frame;
    /** Merged camera result */
    cam: CameraState;
  };
}
export interface VolatileStateHandle {
  volatileRef: React.RefObject<VolatileState>;
  mutate: (mutator: (v: VolatileState) => void) => void;
  update: (patch: Partial<VolatileState>) => void;
  commit: () => void;
  reset: () => void;
  /**
   * Flag-neutral mutation for garbage-collection style cleanup (e.g. dropping
   * shadow buffers of removed frames/layers). Unlike `mutate`, it does NOT set
   * `activeState.interacting = true` — GC is not a user interaction, and forcing
   * the flag on left it stuck `true` after REMOVE_FRAME.
   */
  cleanup: (mutator: (v: VolatileState) => void) => void;
}
