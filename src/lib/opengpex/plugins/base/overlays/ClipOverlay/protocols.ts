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

export const PLUGIN_ID = 'overlays.clip_overlay';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Plugin Config API ───────────────────────────────────────────────────────

export interface ClipOverlayConfig {
  maskOpacity: number;
  marchingAntsAnimated: boolean;
  /** Show the selection dimension chip (clip mode only; never in pan). */
  showDimensionLabel: boolean;
  /**
   * Selection lifecycle policy (default false): a landed Cut / Cut to
   * Layer / peel commit dissolves the active selection; Copy / Copy to
   * Layer always keep it (the source is untouched). Turn on to keep the
   * ants after every operation (e.g. to re-cut the same region). Read
   * cross-plugin by the clear sites — core clip.ts / cmdj.ts receive it
   * as a payload from the ClipOptions wrappers; the peel exit reads it
   * here directly. Absent = the default: readers test `=== true`.
   */
  keepClipBoxAfter?: boolean;
}

/**
 * ClipOverlayAPI: Public facade for cross-plugin access.
 *
 * Usage:
 *   const config = state.pluginConfig[ClipOverlayAPI.configKey] as ClipOverlayConfig;
 */
export const ClipOverlayAPI = {
  /** pluginConfig storage key */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;

// ─── Peel Command Ids ────────────────────────────────────────────────────────
// The peel command family lives in ./commands.ts. The core frame-switch
// guard dispatches settleExchange by the bare id string (it cannot import
// plugin modules) — this file is the single source of truth for it; the
// command registry resolves declared ids through a uid-suffix fallback.

/** Cmd+drag inside the selection: cut the fragment out (or stamp a copy while a session is undecided). */
export const CMD_PEEL_EXCHANGE = 'cmd.peel.exchange';
/** Cancel the undecided peel session (Esc semantics). */
export const CMD_PEEL_DISCARD = 'cmd.peel.discard';
/** Promote the floating fragment (composite stamps + exchange into a regular layer). Internal step of settle — never dispatched by id. */
export const CMD_PEEL_MERGE = 'cmd.peel.merge';
/** THE convergence API for every peel exit path (Enter / Cmd+D / outside cancel / frame switch). */
export const CMD_PEEL_SETTLE = 'cmd.peel.settle';
/** "Reset size": restore the fragment to its peel-time pixels and size. */
export const CMD_PEEL_RESET_TRANSFORM = 'cmd.peel.reset_transform';

// ─── Clip Entry Command Ids (owned here since the selection-lifecycle
// preference `keepClipBoxAfter` lives in this plugin's config; the entry
// wrappers were moved over from ClipOptions) ─────────────────────────────────
export const CMD_LAYER_VIA_COPY = 'cmd.layer_via_copy';
export const CMD_LAYER_VIA_CUT = 'cmd.layer_via_cut';
export const CMD_CLIPBOARD_COPY = 'cmd.clipboard_copy';
export const CMD_CLIPBOARD_CUT = 'cmd.clipboard_cut';
export const CMD_PEEL_COMMIT_EXIT = 'cmd.peel.commit_exit';
export const CMD_PEEL_DISCARD_EXIT = 'cmd.peel.discard_exit';
/** Bake a finished transform gesture into new fragment pixels (write-copy). */
export const CMD_PEEL_APPLY_TRANSFORM = 'cmd.peel.apply_transform';

/** Cross-plugin facade for the peel commands (dispatch by uid). */
export const PeelAPI = {
  uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
  commands: {
    peelToExchange: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_PEEL_EXCHANGE}` } as { uid: string; _payload: { isCopy: boolean } },
    discardExchange: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_PEEL_DISCARD}` } as { uid: string; _payload: void },
    settleExchange: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_PEEL_SETTLE}` } as { uid: string; _payload: { mode: 'commit' | 'discard'; clearSelection?: boolean } },
    resetTransform: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_PEEL_RESET_TRANSFORM}` } as { uid: string; _payload: void },
    applyTransform: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_PEEL_APPLY_TRANSFORM}` } as { uid: string; _payload: { pose: unknown } },
    commitExit: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_PEEL_COMMIT_EXIT}` } as { uid: string; _payload: void },
    discardExit: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_PEEL_DISCARD_EXIT}` } as { uid: string; _payload: void },
  },
};

// ─── Clip Entry Commands (public facade for the ClipOptions shell) ──────────
export const ClipEntryAPI = {
  commands: {
    layerViaCopy: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_LAYER_VIA_COPY}` } as { uid: string; _payload: void },
    layerViaCut: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_LAYER_VIA_CUT}` } as { uid: string; _payload: void },
    clipboardCopy: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_CLIPBOARD_COPY}` } as { uid: string; _payload: void },
    clipboardCut: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_CLIPBOARD_CUT}` } as { uid: string; _payload: void },
  },
};

// ─── Marching Ants Performance Tuning ────────────────────────────────────────

/** CSS animation duration (seconds) for marching ants stroke-dashoffset. */
export const MARCHING_ANTS_DURATION_S = 1;

/**
 * Whether to animate the marching ants (stroke-dashoffset cycling).
 *
 * When `true`: Classic animated marching ants (Photoshop/GIMP style).
 *   - Visually appealing, clear selection boundary indication
 *   - GPU cost: triggers per-frame compositor work; when selection overlaps with
 *     `backdrop-filter` UI panels, can cause 50-90%+ GPU usage
 *
 * When `false`: Static dashed line (Photopea style).
 *   - Zero ongoing GPU cost (no CSS animation = compositor can idle)
 *   - Selection is still clearly visible via dual-path high-contrast technique
 *   - Recommended for devices with limited GPU or when backdrop-filter is used
 *
 * This can be toggled at runtime via user preferences in a future iteration.
 */
export const MARCHING_ANTS_ANIMATED = false;

/**
 * Max total vertices for the marching ants SVG path.
 * Polygons exceeding this are Douglas–Peucker simplified to this budget.
 * Lower = less GPU rasterization cost per frame (fewer path segments to stroke).
 *
 * GPU impact: More vertices = more work for the SVG rasterizer each frame.
 * With animation enabled, this cost is multiplied by the frame rate (60-120fps).
 * With animation disabled (static), vertices only affect initial paint cost.
 *
 * Visual impact: More vertices = smoother/more accurate selection outline.
 * The Ellipse 2 tool uses a fixed 360-point polygon (never exceeds this budget).
 * This limit primarily constrains complex lasso/wand selections.
 *
 * Recommended ranges:
 *   - 200-400: Fast, suitable for simple rect/ellipse selections
 *   - 400-800: Balanced, good for most use cases
 *   - 800-1500: High fidelity, for complex polygon/wand selections
 */
export const MARCHING_ANTS_MAX_VERTICES = 3600;
