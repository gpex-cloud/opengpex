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

/** Non-undoable live variant of cmd.update_properties (continuous slider dragging) */
export const CMD_UPDATE_PROPERTIES_LIVE = 'cmd.update_properties_live';

// ─── Cross-Plugin Constants (cross-plugin references) ───────────────────────────────────────

/** Cross-plugin signal storage key: ID of the text layer currently being edited */
export const TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_EDITING_TEXT_LAYER_ID}`;

/** Cross-plugin signal storage key: current editing session type */
export const TEXT_OVERLAY_SIGNAL_SESSION_TYPE = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_SESSION_TYPE}`;

/** Cross-plugin command UID: enter editing state on an existing text layer (for the select-tool double-click path) */
export const TEXT_OVERLAY_CMD_EDIT_START = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_EDIT_START}`;

// ─── Internal UID Constants (used by plugin internal interactions) ───────────────────────

/** Internal command UID: place new text layer */
export const _CMD_PLACE_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_PLACE}`;

/** Internal command UID: enter editing state */
export const _CMD_EDIT_START_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_EDIT_START}`;

/**
 * Raw-edit-pending flag for the editing session's history flush rule.
 *
 * Typing during a session writes the document directly (the browser's native
 * undo stack owns caret-accurate text undo), so those interim edits sit above
 * the history checkpoint without a step of their own. When a LEDGERED write
 * then happens (a panel style command), the raw edits must first be flushed
 * into their own checkpoint step — otherwise the style command's baseline
 * diff swallows them and one undo reverts typing and style together. The
 * session sets this flag on every raw write; the panel clears it whenever it
 * flushes before a command. Plain module state (not a store signal): one text
 * session exists at a time and the flag is written and consumed synchronously
 * within a single dispatch flow.
 */
export const TEXT_SESSION_RAW_EDITS = { pending: false };

/**
 * DOM custom event used by the two-stage click arbitration: the TextPlaceHandler
 * dispatches it on window when the user clicks the canvas while a text layer is
 * being edited; the InlineTextEditor listens and runs its commitEditing. The
 * handler owns the gesture, the editor owns the session — this event is the
 * only bridge between the two.
 */
export const TEXT_OVERLAY_EVT_COMMIT_REQUEST = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.commit_request`;

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
    /** Non-undoable live variant of updateProperties (continuous slider dragging) */
    updatePropertiesLive: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.cmd.update_properties_live` } as { uid: string; _payload: { frameId: string; layerId: string; patch: unknown } },
    /** Activate an existing text layer and enter inline editing (select-tool double-click) */
    editStart: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_EDIT_START}` } as { uid: string; _payload: { frameId: string; layerId: string } },
  },
} as const;

// ─── Session Types ─────────────────────────────────────────────────────────────

import type { TextLayerData } from '@opengpex/editor/core/types/models';
import type { LocalShape } from '@opengpex/editor/core/types';

/**
 * Volatile transient key carrying the drag-to-create marquee rect (canvas-local).
 * Deliberately NOT a store signal: the marquee updates at pointermove rate, and
 * routing it through Redux re-renders the whole React tree per move — at 60 Hz
 * on heavy documents the concurrent renderer accumulates nested updates past
 * React's limit and crashes ("Maximum update depth exceeded"). The volatile
 * fast track drives the preview via a Ticker + DOM refs with zero renders
 * (same channel as ClipOverlay's `clipMoveStart`).
 */
export const TEXT_PLACE_MARQUEE_TRANSIENT_KEY = 'textPlaceMarquee';

/** Marquee preview rect (canvas-local) carried by TEXT_PLACE_MARQUEE_TRANSIENT_KEY */
export interface PlaceMarqueeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Text editing session context (held in useRef during editing) */
export interface TextEditingSession {
  type: 'create' | 'modify';
  layerId: string;
  frameId: string;
  /**
   * Layer snapshot captured when a MODIFY session opens (before entering
   * editing). Create sessions capture nothing: their slow track is never
   * written during the session, so the empty-content exit only needs
   * rewindTo + undo against the place checkpoint.
   *
   * Content and layout only — cx/cy/rotation are deliberately excluded:
   * geometry moved with Cmd/Ctrl+Drag during editing commits through its own
   * independent undoable transaction and must survive cancel (Esc restores
   * content only).
   */
  originalSnapshot: {
    textData: TextLayerData;
    bounding: { w: number; h: number };
    visibleShape: LocalShape;
  } | null;
  /** Guard flag: session has ended, prevents subsequent blur callbacks */
  disposed: boolean;
  /**
   * Undo-stack length when the session opened (history.mark). Session-cancel
   * rewinds the stack to this mark: steps recorded inside the session (per-op
   * style commands) must die with the cancel, because the snapshot restore
   * replaces the states those steps were diffed against.
   */
  historyMark: number;
}

