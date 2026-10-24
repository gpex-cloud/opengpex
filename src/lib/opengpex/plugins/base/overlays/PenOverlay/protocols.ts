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
 * PenOverlay Plugin Protocols
 *
 * Constants + typed facade for the pen (bézier path) tool overlay. Renders in
 * STAGE_OVERLAY; activated when activeCraft === 'pen'. The tool's draft lives
 * in the scratch service's per-frame slot (accessed via actions.scratch);
 * commit goes through the undoable commands declared here.
 */

export const PLUGIN_ID = 'overlays.pen_overlay';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Signal IDs ────────────────────────────────────────────────────────────────

/**
 * The pen tool's coarse phase ('idle' | 'drawing' | 'editing'; 'editing' is
 * reserved for Phase 3). Drives the panel's commit gate together with the
 * draft payload in the scratch slot; written by the interactions on phase
 * transitions and re-published on frame switches.
 */
export const SIGNAL_PEN_PHASE = 'signal.pen_phase';

// ─── Command IDs ───────────────────────────────────────────────────────────────

/** Applies the session's closed rings to the active layer as a feathered VectorMask (undoable). */
export const CMD_APPLY_MASK = 'cmd.pen_apply_mask';

/** Commits the session's closed rings as the frame's 'pen'-slot selection (undoable). */
export const CMD_TO_SELECTION = 'cmd.pen_to_selection';

/** Converts the frame's current selection into an editable pen draft and activates the pen tool. */
export const CMD_APPLY_AS_BEZIER = 'cmd.pen_apply_as_bezier';

/** Aborts the drawing session (panel "Discard" / programmatic cancel). */
export const CMD_CANCEL_DRAFT = 'cmd.pen_cancel_draft';

/** Patches a committed layer's `penData` (anchor deletion etc., undoable). */
export const CMD_UPDATE_PEN_DATA = 'cmd.pen_update_data';

/** Commits the session's paths as a new vector shape layer (undoable, Phase 3). */
export const CMD_CREATE_SHAPE = 'cmd.pen_create_shape';

/**
 * Releases a committed pen shape layer's path back into the drawing session
 * as the editable draft and removes the layer (undoable — undo re-adds the
 * layer; the restored draft is outside history and stays).
 */
export const CMD_RELEASE_TO_DRAFT = 'cmd.pen_release_to_draft';

// ─── Internal UID Constants ──────────────────────────────────────────────────────

export const _CMD_APPLY_MASK_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_APPLY_MASK}`;
export const _CMD_TO_SELECTION_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_TO_SELECTION}`;
export const _CMD_APPLY_AS_BEZIER_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_APPLY_AS_BEZIER}`;
export const _CMD_CANCEL_DRAFT_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_CANCEL_DRAFT}`;
export const _CMD_UPDATE_PEN_DATA_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_UPDATE_PEN_DATA}`;
export const _CMD_CREATE_SHAPE_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_CREATE_SHAPE}`;
export const _CMD_RELEASE_TO_DRAFT_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_RELEASE_TO_DRAFT}`;

// ─── Cross-Plugin Typed Facade ──────────────────────────────────────────────────

export const PenOverlayAPI = {
  signals: {
    /** Pen tool phase ('idle' | 'drawing' | 'editing') */
    phase: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_PEN_PHASE}` as const,
  },
  commands: {
    /** Apply the session's closed rings as a feathered mask on the active layer */
    applyMask: { uid: _CMD_APPLY_MASK_UID } as { uid: string; _payload: void },
    /** Commit the session's closed rings as the frame's pen-slot selection */
    toSelection: { uid: _CMD_TO_SELECTION_UID } as { uid: string; _payload: void },
/** Convert the frame's current selection into an editable pen draft (activates the pen tool) */
    applyAsBezier: { uid: _CMD_APPLY_AS_BEZIER_UID } as { uid: string; _payload: void },
    /** Abort the drawing session */
    cancelDraft: { uid: _CMD_CANCEL_DRAFT_UID } as { uid: string; _payload: void },
    /** Patch a committed layer's penData (set null to clear) */
    updatePenData: { uid: _CMD_UPDATE_PEN_DATA_UID } as { uid: string; _payload: { frameId: string; layerId: string; penData: import('@opengpex/editor/core/types').PenPathData | null } },
    /** Commit the session's paths as a new vector shape layer */
    createShape: { uid: _CMD_CREATE_SHAPE_UID } as { uid: string; _payload: import('./contribution').PenShapeStylePayload },
    /** Release a committed pen layer's path into the drawing session and remove the layer */
    releaseToDraft: { uid: _CMD_RELEASE_TO_DRAFT_UID } as { uid: string; _payload: { frameId: string; layerId: string } },
  },
  /** pluginConfig storage key */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;

// ─── Shared thresholds ─────────────────────────────────────────────────────────

/**
 * Hit tolerance in SCREEN pixels for anchor/handle/segment targets. Shared by
 * pen-draw (place-vs-close arbitration) and pen-edit (which target a press
 * lands on); callers divide by the camera scale to get canvas px.
 */
export const PEN_HIT_TOLERANCE_SCREEN_PX = 8;

/**
 * Default fitting tolerance (document px) when importing a selection into the
 * pen tool. Same order as the AI workers' RDP epsilon (1.5 px): the fit must
 * not be coarser than its source polyline.
 */
export const PEN_IMPORT_FIT_TOLERANCE_DOC_PX = 1.0;

/**
 * Default anchor budget for "Apply as Bezier" when the pen panel's slider
 * has never been touched. The slider's four fixed detents are 100/200/300/400;
 * this default matches the second (middle) detent.
 */
export const PEN_IMPORT_DEFAULT_ANCHOR_BUDGET = 200;

/**
 * Flatten tolerance (document px) when committing a pen path to a mask or a
 * selection. At vmask's 1px AA / feather scale, 0.25 px of chord deviation is
 * invisible — the same constant the spec pins for the cubic → polyline exit.
 */
export const PEN_FLATTEN_TOLERANCE_DOC_PX = 0.25;
