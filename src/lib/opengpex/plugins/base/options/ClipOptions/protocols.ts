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

export const PLUGIN_ID = 'options.clip_options';
export const PLUGIN_AUTHOR = 'opengpex';

export const CMD_RE_CANVAS_TOGGLE = 'cmd.re_canvas.toggle';
export const CMD_RE_CANVAS_APPLY = 'cmd.re_canvas.apply';
/** Space — enter clip mode (no-op when already in clip). Pairs with `CMD_EXIT_CLIP_MODE`. */
export const CMD_TOGGLE_MODE = 'cmd.toggle_mode';
/**
 * Shift+Space — reverse cycle through clip tools while already in clip
 * mode. Mirrors `CMD_TOGGLE_MODE`'s subsequent-press cycling but stepping
 * backward (rect ← ellipse ← lasso ← wand ← rect …). When NOT yet in clip
 * mode, behaves identically to `CMD_TOGGLE_MODE` (just enters clip),
 * because shift accidentally held while pressing Space shouldn't yank
 * the user backward through the tool list.
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
export const CMD_SET_ASPECT = 'cmd.set_aspect';
export const CMD_RESET_ASPECT = 'cmd.reset_aspect';
export const CMD_BRANCH = 'cmd.branch.create';
export const CMD_RESET_BOX = 'cmd.box.reset';
export const CMD_TOGGLE_ANTI_ALIAS = 'cmd.anti_alias.toggle';
export const CMD_SET_CROP_TOOL = 'cmd.crop_tool.set';

export const SIGNAL_RE_CANVAS = 'signal.re_canvas.active';

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

/* ──────────────────────────────────────────────────────────────────────────
 * Pre-PR-6-2  ::  CropTool Strategy Table (Single Source of Truth)
 *
 * The five-or-more flavour properties of every clip tool — UI icon, palette,
 * data-write family, interaction handler kind, projection-on-switch, and
 * Re-Canvas mutual-exclusion — used to be scattered as if/else branches across
 * six call-sites:
 *   L1 visual    : ClipOptions/components.tsx        (TOOL_VISUAL table)
 *   L2 behavior  : ClipOptions/commands.ts           (setCropTool if-chain)
 *   L3 channel   : ClipOverlay/components.tsx        (isRegularTool / isIrregularTool literal)
 *   L4 handler   : ClipOverlay/interactions.ts       (per-handler test() guards)
 *   L5 data write: ClipOverlay/interactions.ts       (lasso onEnd → adv.irregular.set vs setIrregularCropBox)
 *   L6 mutex     : ClipOptions/commands.ts           (Re-Canvas force-rect interceptor)
 *
 * Each new tool used to require a 6-touch coordinated change with no compiler
 * help, exactly the failure mode this table eliminates: now a new tool is
 * literally one row added to `CROP_TOOL_STRATEGIES`. The narrow `LucideIcon`
 * import is local-only on purpose so this file remains shareable across L3–L6
 * consumers without dragging in unrelated UI deps.
 * ──────────────────────────────────────────────────────────────────────── */

import type { LucideIcon } from 'lucide-react';
import { Square, Circle, Lasso, Wand2 } from 'lucide-react';
import {
  CLIP_RECT_CURSOR,
  CLIP_ELLIPSE_CURSOR,
  CLIP_LASSO_CURSOR,
  CLIP_WAND_CURSOR,
} from '@opengpex/editor/icons';

export type CropFamily = 'regular' | 'irregular';

export interface CropToolStrategy {
  /** L1 visual */
  readonly id: CropTool;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly accent: 'amber' | 'purple';

  /**
   * Semantic category — purely describes the geometry kind this tool produces:
   *   - `regular`:   LocalShape (rect/circle with axis-aligned bounding rect)
   *   - `irregular`: LocalPolygon (multi-ring point set)
   *
   * Data-write routing is unified: all tools write to `clipBoxes[toolId]` via
   * `actions.setClipBox(frameId, toolId, data)`. The `family` field is no longer
   * used for routing; it serves only as a semantic discriminator for:
   *   - UI accent colour (amber = regular, purple = irregular)
   *   - `setCropTool` projection logic (only regular tools project `type`)
   *   - `getClipBox().regular` mirrors this at read time
   */
  readonly family: CropFamily;

  /**
   * L4 handler dispatch hint — consumed only inside ClipOverlay/interactions.ts
   * via `makeCropToolGuard(handlerKind)`. External call-sites should use
   * `getClipBox().regular` for data-level branching.
   */
  readonly handlerKind: 'clipbox' | 'lasso' | 'wand';

  /**
   * Shape projection on tool-switch — only meaningful for `regular` tools.
   * When defined, `setCropTool` patches `clipBoxes[newSlot].type` to the
   * returned value. `undefined` for irregular tools → no projection.
   *
   * `antiAliased` is intentionally optional: when omitted, `setCropTool`
   * preserves the box's existing AA flag so the orthogonal AA toggle remains
   * the sole owner of that field.
   */
  readonly projectShape?: () => { type: 'rect' | 'circle'; antiAliased?: boolean };

  /**
   * Re-Canvas mutex — `true` means this tool cannot operate while Re-Canvas
   * is active (canvas resizing only makes sense on a rectangular footprint).
   * The guard is purely visual/dispatch — no data coercion occurs.
   */
  readonly forbiddenInReCanvas: boolean;

  /**
   * Whether the tool supports the anti-alias toggle. Drives the Options-bar
   * `AA` button's `disabled` state.
   *
   * `rect` is always pixel-aligned → `false`.
   * All other tools (`ellipse`, `lasso`, `wand`) support AA toggling via the
   * `antiAliased` field on their respective spatial (LocalShape or LocalPolygon).
   * All tools default AA to ON (true); user can toggle OFF at any time.
   */
  readonly supportsAntiAlias: boolean;

  /**
   * Custom cursor for this clip tool — applied to the viewport via
   * `cursorOverride` when this tool is active in clip mode. Uses CSS cursor
   * syntax (supports data URL SVG cursors with hotspot specification).
   * Consumed by `useClipCursor` hook in ClipOverlay.
   */
  readonly cursor: string;
}

/**
 * CROP_TOOL_STRATEGIES — Single Source of Truth.
 *
 * Adding a new tool: add one row here, then
 *   1. (optional) add a handler factory in ClipOverlay/interactions.ts whose
 *      `test()` uses `makeCropToolGuard('<your-handlerKind>')`
 *   2. nothing else — L1/L2/L3/L6 derive automatically.
 */
export const CROP_TOOL_STRATEGIES: Record<CropTool, CropToolStrategy> = {
  'rect':    { id: 'rect',    label: 'Rect',    icon: Square, accent: 'amber',  family: 'regular',   handlerKind: 'clipbox', projectShape: () => ({ type: 'rect'   }), forbiddenInReCanvas: false, supportsAntiAlias: false, cursor: CLIP_RECT_CURSOR    },
  'ellipse': { id: 'ellipse', label: 'Ellipse', icon: Circle, accent: 'amber',  family: 'regular',   handlerKind: 'clipbox', projectShape: () => ({ type: 'circle' }), forbiddenInReCanvas: false, supportsAntiAlias: true,  cursor: CLIP_ELLIPSE_CURSOR },
  'lasso':   { id: 'lasso',   label: 'Lasso',   icon: Lasso,  accent: 'purple', family: 'irregular', handlerKind: 'lasso',                                              forbiddenInReCanvas: true,  supportsAntiAlias: true,  cursor: CLIP_LASSO_CURSOR   },
  'wand':    { id: 'wand',    label: 'Wand',    icon: Wand2,  accent: 'purple', family: 'irregular', handlerKind: 'wand',                                               forbiddenInReCanvas: true,  supportsAntiAlias: true,  cursor: CLIP_WAND_CURSOR    },

};

/**
 * Derived helpers — kept as named exports for searchability and call-site
 * readability. Both go through CROP_TOOL_STRATEGIES so there is no duplicate
 * source of truth (`if (isIrregularTool(tool))` ≡ `if (CROP_TOOL_STRATEGIES[tool].family === 'irregular')`).
 */
export const isRegularTool   = (t: CropTool): boolean => CROP_TOOL_STRATEGIES[t].family === 'regular';
export const isIrregularTool = (t: CropTool): boolean => CROP_TOOL_STRATEGIES[t].family === 'irregular';

// Cross-plugin reference UIDs (for use by external consumers via actions.executeCommand)
export const CLIP_OPTIONS_CMD_TOGGLE_MODE = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_TOGGLE_MODE}`;
export const CLIP_OPTIONS_CMD_RESET_BOX = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_RESET_BOX}`;
export const CLIP_OPTIONS_CMD_BRANCH = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_BRANCH}`;
export const CLIP_OPTIONS_CMD_SET_CROP_TOOL = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SET_CROP_TOOL}`;
export const CLIP_OPTIONS_SIGNAL_RE_CANVAS = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_RE_CANVAS}`;

