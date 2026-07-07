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

export const PLUGIN_ID = 'drawers.layer';
export const PLUGIN_AUTHOR = 'opengpex';

/* Command IDs */
export const CMD_REMOVE = 'cmd.remove';
export const CMD_REORDER = 'cmd.reorder';
export const CMD_VISIBILITY = 'cmd.visibility';
export const CMD_LOCK = 'cmd.lock';
export const CMD_RENAME = 'cmd.rename';
export const CMD_ADD_BLANK_LAYER = 'cmd.add_blank_layer';
export const CMD_DUPLICATE_LAYER = 'cmd.duplicate_layer';
export const CMD_SYNC_TO_OVERLAY = 'cmd.sync.overlay';
export const CMD_MASK_SYNC_TO_OVERLAY = 'cmd.sync.mask';
export const CMD_SET_BLEND_MODE = 'cmd.set_blend_mode';
export const CMD_SET_LAYER_OPACITY = 'cmd.set_layer_opacity';
export const CMD_SET_LAYER_FILL = 'cmd.set_layer_fill';

// ─── Mask Edit Signal ──────────────────────────────────────────────────────────

/** Signal key for mask editing target (stored in interaction.signals) */
export const MASK_EDITING_KEY = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.signal.mask_editing`;

/** Signal key for mask focus highlight overlay toggle */
export const MASK_FOCUS_KEY = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.signal.mask_focus`;

/** Signal key for showing sub-layers collapse/expand button */
export const SHOW_SUB_LAYERS_KEY = 'signal.show_sub_layers';

/**
 * MaskEditingSignal: Indicates which bitmap mask is currently being edited.
 * null = no mask is being edited.
 */
export type MaskEditingSignal = {
  layerId: string;
  maskId: string;
} | null;

/**
 * MaskFocusSignal: Whether to highlight/isolate the mask currently being edited.
 */
export type MaskFocusSignal = boolean;

/**
 * LayerDrawerAPI: Cross-plugin typed facade for external consumers.
 */
export const LayerDrawerAPI = {
  signals: {
    maskEditing: MASK_EDITING_KEY,
    maskFocus: MASK_FOCUS_KEY,
    showSubLayers: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SHOW_SUB_LAYERS_KEY}` as const,
  },
} as const;
