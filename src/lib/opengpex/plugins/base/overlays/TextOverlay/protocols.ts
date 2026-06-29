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
 * TextOverlay Plugin Protocols
 *
 * Defines constants and signals for text overlay plugin.
 * TextOverlay renders inline text editor in STAGE_OVERLAY layer.
 */

export const PLUGIN_ID = 'overlays.text_overlay';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Signal IDs ────────────────────────────────────────────────────────────────

/** ID of the text layer currently being edited (null = no editing state) */
export const SIGNAL_EDITING_TEXT_LAYER_ID = 'signal.editing_text_layer_id';

/** Current editing session type: 'create' | 'modify' | null */
export const SIGNAL_SESSION_TYPE = 'signal.session_type';

// ─── Command IDs ───────────────────────────────────────────────────────────────

/** Places a new text layer and enters editing state */
export const CMD_PLACE = 'cmd.place';

/** Activates an existing text layer and enters editing state */
export const CMD_EDIT_START = 'cmd.edit_start';

/** Updates text layer style attributes (font size/color/alignment, etc.) */
export const CMD_UPDATE_PROPERTIES = 'cmd.update_properties';

/** Commits a modify session with full layer patch (internal, creates undo point) */
export const CMD_MODIFY_COMMIT = 'cmd.modify_commit';

// ─── Cross-Plugin Constants (cross-plugin references) ───────────────────────────────────────

/** Cross-plugin signal storage key: ID of the text layer currently being edited */
export const TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_EDITING_TEXT_LAYER_ID}`;

/** Cross-plugin signal storage key: current editing session type */
export const TEXT_OVERLAY_SIGNAL_SESSION_TYPE = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_SESSION_TYPE}`;

/** Cross-plugin command UID: update text attributes (for external plugins like CraftDrawer to call) */
export const TEXT_OVERLAY_CMD_UPDATE_PROPERTIES = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_UPDATE_PROPERTIES}`;

// ─── Internal UID Constants (used by plugin internal interactions) ───────────────────────

/** Internal command UID: place new text layer */
export const _CMD_PLACE_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_PLACE}`;

/** Internal command UID: enter editing state */
export const _CMD_EDIT_START_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_EDIT_START}`;

/** Internal command UID: commit modify session */
export const _CMD_MODIFY_COMMIT_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_MODIFY_COMMIT}`;

// ─── Cross-Plugin Typed Facade ──────────────────────────────────────────────────

/**
 * TextOverlayAPI: Structured cross-plugin facade for external consumers.
 *
 * Usage:
 *   import { TextOverlayAPI } from '../../overlays/TextOverlay/protocols';
 *   const editingId = state.interaction.signals[TextOverlayAPI.signals.editingTextLayerId];
 *   actions.executeCommand(TextOverlayAPI.commands.updateProperties.uid, payload);
 */
export const TextOverlayAPI = {
  signals: {
    /** ID of the text layer currently being edited (null = idle) */
    editingTextLayerId: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_EDITING_TEXT_LAYER_ID}` as const,
    /** Current editing session type: 'create' | 'modify' | null */
    sessionType: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_SESSION_TYPE}` as const,
  },
  commands: {
    /** Update text layer style attributes (font size/color/alignment) */
    updateProperties: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_UPDATE_PROPERTIES}` } as { uid: string; _payload: { frameId: string; layerId: string; patch: unknown } },
  },
} as const;

// ─── Session Types ─────────────────────────────────────────────────────────────

import type { TextLayerData } from '@opengpex/editor/core/types/models';
import type { LocalShape } from '@opengpex/editor/core/types';

/** Text editing session context (held in useRef during editing) */
export interface TextEditingSession {
  type: 'create' | 'modify';
  layerId: string;
  frameId: string;
  /** modify session: layer snapshot captured before entering editing */
  originalSnapshot: {
    assetId: string;
    src: string;
    textData: TextLayerData;
    bounding: { w: number; h: number };
    visibleShape: LocalShape;
    cx: number;
    cy: number;
  } | null;
  /** Guard flag: session has ended, prevents subsequent blur callbacks */
  disposed: boolean;
}

