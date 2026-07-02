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

import type { LucideIcon } from 'lucide-react';
import { Square, Circle, Lasso, Wand2 } from 'lucide-react';
import {
  CLIP_RECT_CURSOR,
  CLIP_ELLIPSE_CURSOR,
  CLIP_LASSO_CURSOR,
  CLIP_WAND_CURSOR,
} from '@opengpex/editor/icons';

// ─── Plugin Identity ────────────────────────────────────────────────────────────

export const PLUGIN_ID = 'options.clip_options';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Command IDs ────────────────────────────────────────────────────────────────

/** Space — toggle clip mode (enter ↔ exit). Pairs with `CMD_EXIT_CLIP_MODE` (Esc). */
export const CMD_TOGGLE_MODE = 'cmd.toggle_mode';

/**
 * Tab — cycle through clip tools forward while already in clip mode
 * (rect → ellipse → lasso → wand → rect …). Only active when
 * `interactionMode === 'clip'`; no-op in any other mode.
 */
export const CMD_CYCLE_TOOL_FORWARD = 'cmd.crop_tool.cycle_forward';

/**
 * Shift+Tab — reverse cycle through clip tools while already in clip
 * mode (rect ← ellipse ← lasso ← wand ← rect …). Only active when
 * `interactionMode === 'clip'`; no-op in any other mode.
 */
export const CMD_CYCLE_TOOL_BACKWARD = 'cmd.crop_tool.cycle_backward';

/**
 * Escape — leave clip mode. Atomically clears the Re-Canvas signal if set,
 * then routes through `exitClipMode` to commit the cascade-state-machine
 * triplet and flip interactionMode → 'pan'.
 */
export const CMD_EXIT_CLIP_MODE = 'cmd.exit_clip_mode';

/**
 * Enter — commit the peel (merge exchange into host). Separated from Esc
 * (which now only discards/cancels) so that baking requires an explicit
 * confirmation gesture. Matches the Photoshop "Enter = confirm transform"
 * mental model.
 */
export const CMD_COMMIT_PEEL = 'cmd.peel.commit';

export const CMD_RE_CANVAS_TOGGLE = 'cmd.re_canvas.toggle';
export const CMD_RE_CANVAS_APPLY = 'cmd.re_canvas.apply';
export const CMD_SET_ASPECT = 'cmd.set_aspect';
export const CMD_RESET_ASPECT = 'cmd.reset_aspect';
export const CMD_BRANCH = 'cmd.branch.create';
export const CMD_RESET_BOX = 'cmd.box.reset';
export const CMD_TOGGLE_ANTI_ALIAS = 'cmd.anti_alias.toggle';
export const CMD_SET_CROP_TOOL = 'cmd.crop_tool.set';

/**
 * Plugin-level wrapper around `adv.layer.clip.drill`.
 * Owns the Backspace/Delete keyboard shortcuts and reads the feather signal
 * before delegating to the core drill command with the feather payload.
 */
export const CMD_DRILL_SELECTION = 'cmd.drill_selection';

/**
 * Plugin-level wrapper around `adv.layer.cmdj.copy`.
 * Owns the Cmd+J keyboard shortcut and reads the feather signal before
 * delegating to the core command with the feather payload.
 */
export const CMD_LAYER_VIA_COPY = 'cmd.layer_via_copy';

/**
 * Plugin-level wrapper around `adv.layer.cmdj.cut`.
 * Owns the Cmd+Shift+J keyboard shortcut and reads the feather signal before
 * delegating to the core command with the feather payload.
 */
export const CMD_LAYER_VIA_CUT = 'cmd.layer_via_cut';

// ─── Signal IDs ─────────────────────────────────────────────────────────────────

export const SIGNAL_RE_CANVAS = 'signal.re_canvas.active';

/** Feather radius (px) for Apply Mask / Drill */
export const SIGNAL_CROP_FEATHER = 'signal.crop_feather.value';

// ─── Types ──────────────────────────────────────────────────────────────────────

/**
 * CropTool: Active crop / selection tool.
 *
 * - 'rect' / 'ellipse'  → regular shapes (amber UI accent).
 * - 'lasso' / 'wand'    → irregular polygon selections (purple UI accent).
 *
 * All tools write to the unified `clipBoxes[toolId]` record via
 * `actions.setClipBox(frameId, toolId, data)`. The CropTool↔Shape.type
 * mapping is one-way (CropTool → Shape.type), driven by `setCropTool`'s
 * `projectShape` at tool-switch time.
 *
 * Anti-aliasing is **orthogonal** to tool identity — driven by the standalone
 * `AA` button (command `CMD_TOGGLE_ANTI_ALIAS`) which toggles the
 * `antiAliased` field on the active clip box's spatial. All tools default
 * AA to ON (true). The strategy table declares which tools expose this
 * control via `supportsAntiAlias`.
 */
export type CropTool = 'rect' | 'ellipse' | 'lasso' | 'wand';

export type CropFamily = 'regular' | 'irregular';

export interface CropToolStrategy {
  readonly id: CropTool;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly accent: 'amber' | 'purple';

  /**
   * Semantic category — purely describes the geometry kind this tool produces:
   *   - `regular`:   LocalShape (rect/circle with axis-aligned bounding rect)
   *   - `irregular`: LocalPolygon (multi-ring point set)
   */
  readonly family: CropFamily;

  /**
   * Handler dispatch hint — consumed by `makeCropToolGuard(handlerKind)` in
   * ClipOverlay/interactions.ts. External call-sites should use
   * `getClipBox().regular` for data-level branching.
   */
  readonly handlerKind: 'clipbox' | 'lasso' | 'wand';

  /**
   * Shape projection on tool-switch — only meaningful for `regular` tools.
   * When defined, `setCropTool` patches `clipBoxes[newSlot].type` to the
   * returned value. `undefined` for irregular tools → no projection.
   */
  readonly projectShape?: () => { type: 'rect' | 'circle'; antiAliased?: boolean };

  /**
   * Re-Canvas mutex — `true` means this tool cannot operate while Re-Canvas
   * is active (canvas resizing only makes sense on a rectangular footprint).
   */
  readonly forbiddenInReCanvas: boolean;

  /**
   * Whether the tool supports the anti-alias toggle. Drives the Options-bar
   * `AA` button's `disabled` state. `rect` is always pixel-aligned → `false`.
   */
  readonly supportsAntiAlias: boolean;

  /**
   * Custom cursor for this clip tool — applied to the viewport via
   * `cursorOverride` when this tool is active in clip mode.
   */
  readonly cursor: string;
}

// ─── Strategy Table ─────────────────────────────────────────────────────────────
//
// Single Source of Truth for all clip tool properties. Adding a new tool:
//   1. Add one row here.
//   2. (optional) Add a handler factory in ClipOverlay/interactions.ts whose
//      `test()` uses `makeCropToolGuard('<your-handlerKind>')`.
//   3. Nothing else — all derived code reads from this table.

export const CROP_TOOL_STRATEGIES: Record<CropTool, CropToolStrategy> = {
  'rect':    { id: 'rect',    label: 'Rect',    icon: Square, accent: 'amber',  family: 'regular',   handlerKind: 'clipbox', projectShape: () => ({ type: 'rect'   }), forbiddenInReCanvas: false, supportsAntiAlias: false, cursor: CLIP_RECT_CURSOR    },
  'ellipse': { id: 'ellipse', label: 'Ellipse', icon: Circle, accent: 'amber',  family: 'regular',   handlerKind: 'clipbox', projectShape: () => ({ type: 'circle' }), forbiddenInReCanvas: false, supportsAntiAlias: true,  cursor: CLIP_ELLIPSE_CURSOR },
  'lasso':   { id: 'lasso',   label: 'Lasso',   icon: Lasso,  accent: 'purple', family: 'irregular', handlerKind: 'lasso',                                              forbiddenInReCanvas: true,  supportsAntiAlias: true,  cursor: CLIP_LASSO_CURSOR   },
  'wand':    { id: 'wand',    label: 'Wand',    icon: Wand2,  accent: 'purple', family: 'irregular', handlerKind: 'wand',                                               forbiddenInReCanvas: true,  supportsAntiAlias: true,  cursor: CLIP_WAND_CURSOR    },
};

// ─── Derived Helpers ────────────────────────────────────────────────────────────

export const isRegularTool   = (t: CropTool): boolean => CROP_TOOL_STRATEGIES[t]?.family === 'regular';
export const isIrregularTool = (t: CropTool): boolean => CROP_TOOL_STRATEGIES[t]?.family === 'irregular';

// ─── Cross-Plugin Typed Facade ──────────────────────────────────────────────────

/**
 * ClipOptionsAPI: Structured cross-plugin facade for external consumers.
 *
 * Usage:
 *   import { ClipOptionsAPI } from '../../options/ClipOptions/protocols';
 *   state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
 *   actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
 */
export const ClipOptionsAPI = {
  signals: {
    /** Canvas Re-Size active status */
    reCanvas: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_RE_CANVAS}` as const,
    /** Feather radius (px) for Apply Mask / Drill */
    cropFeather: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_CROP_FEATHER}` as const,
  },
  commands: {
    /** Clear the active selection (double-click reset) */
    resetBox: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_RESET_BOX}` } as { uid: string; _payload: void },
    /** Enter / Cycle Clip Tool */
    toggleMode: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_TOGGLE_MODE}` } as { uid: string; _payload: void },
    /** Set crop tool */
    setCropTool: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SET_CROP_TOOL}` } as { uid: string; _payload: { tool: CropTool } },
  },
  /** pluginConfig storage key */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;

