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
 * MarkerOverlay Plugin Protocols
 *
 * Constants + typed facade for the marker drawing overlay (rect / arrow).
 * MarkerOverlay renders in STAGE_OVERLAY: a real-time SVG drag preview plus
 * hit-testing/move for existing marker (`type:'vector' + markerData`) layers.
 */

export const PLUGIN_ID = 'overlays.marker_overlay';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Signal IDs ────────────────────────────────────────────────────────────────

/** Whether a marker drag-draw is currently in progress (boolean). */
export const SIGNAL_DRAWING_MARKER = 'signal.drawing_marker';

// ─── Command IDs ───────────────────────────────────────────────────────────────

/** Places a newly drawn marker as a `type:'vector'` layer (undoable). */
export const CMD_PLACE = 'cmd.place';

/** Updates the markerData of an existing marker layer (undoable — panel edits). */
export const CMD_UPDATE_MARKER = 'cmd.update_marker';

// ─── Internal UID Constants ──────────────────────────────────────────────────────

/** Internal command UID: place a new marker layer */
export const _CMD_PLACE_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_PLACE}`;

/** Cross-plugin command UID: update marker properties (called by MarkerPanel) */
export const MARKER_OVERLAY_CMD_UPDATE_MARKER = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_UPDATE_MARKER}`;

// ─── Cross-Plugin Typed Facade ──────────────────────────────────────────────────

/**
 * MarkerOverlayAPI: structured cross-plugin facade for external consumers
 * (e.g. CraftDrawer's MarkerPanel binding to update the selected marker).
 */
export const MarkerOverlayAPI = {
  signals: {
    /** Whether a marker drag-draw is currently in progress */
    drawingMarker: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_DRAWING_MARKER}` as const,
  },
  commands: {
    /** Update the markerData of an existing marker layer */
    updateMarker: { uid: MARKER_OVERLAY_CMD_UPDATE_MARKER } as {
      uid: string;
      _payload: { frameId: string; layerId: string; patch: unknown };
    },
  },
  /** pluginConfig storage key */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;
