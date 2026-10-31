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

import { GeometryService, Frame, Layer, InteractionEvent } from '@opengpex/editor/core/types';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import { TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, _CMD_PLACE_UID, _CMD_EDIT_START_UID } from '../protocols';

// ─── Edit-start caret handoff ──────────────────────────────────────────────────

/**
 * One-shot handoff of the pointer position that started a text edit session.
 *
 * The interaction handlers (text-place click, pan-mode double-click, bare
 * pre-edit press) know WHERE the user clicked, but the inline editor mounts
 * later (React effect). The starter stores the viewport-space point here; the
 * editor's init effect consumes it once to drop the caret at the clicked
 * position (via TextCaretKit's placeCaretAtPoint) instead of always
 * collapsing to the text end. Consume-on-read: the value is only valid for
 * the very next session mount; non-pointer entry paths never store one and
 * get the fallback.
 */
export interface PendingEditCaretPoint {
  clientX: number;
  clientY: number;
}

let pendingEditCaretPoint: PendingEditCaretPoint | null = null;

export function setPendingEditCaretPoint(point: PendingEditCaretPoint): void {
  pendingEditCaretPoint = point;
}

export function consumePendingEditCaretPoint(): PendingEditCaretPoint | null {
  const point = pendingEditCaretPoint;
  pendingEditCaretPoint = null;
  return point;
}

/** Shared signal keys (cross-plugin constants) */
export const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;
export const EDITING_TEXT_KEY = TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID;

/** Command UIDs (from protocols, Single Source of Truth) */
export const CMD_PLACE_UID = _CMD_PLACE_UID;
export const CMD_EDIT_START_UID = _CMD_EDIT_START_UID;

/**
 * Finds hit layer of type 'text' using core geometry hit-testing.
 * Uses pickLayersAt (supports visibleShape, rotation, interactive flag) filtered to text layers.
 * Accepts canvas-local point and converts to world coordinates via geometry service.
 */
export function findTextLayerAtPoint(geometry: GeometryService, frame: Frame, point: { x: number; y: number }): Layer | null {
  const worldPoint = geometry.space.localToWorld(point.x, point.y, frame);
  const hits = geometry.space.pickLayersAt(worldPoint, frame.layers);
  return hits.find((l: Layer) => l.type === 'text') || null;
}

/** Hit test restricted to layers a press can actually enter/move: visible,
 * unlocked, real text content. Press-to-edit and press-to-move must never
 * fire on a locked or hidden text layer. */
export function findEditableTextLayerAtPoint(e: InteractionEvent): Layer | null {
  const hits = e.geometry.space.pickLayersAt(e.point.world, e.activeFrame.layers);
  return hits.find((l: Layer) => l.type === 'text' && l.visible && !l.locked && !!l.textData) || null;
}

/**
 * Resolves the text layer a transform-gizmo handle belongs to. The pre-edit
 * frame (corners / edge ticks / rotate handle) is drawn by TextOverlay itself
 * (components/PreEditFrame) and its box carries
 * `data-overlay-gizmo-layer=<layerId>`, so the hit DOM node identifies the
 * target unambiguously (the editing-state gizmo was removed with the
 * session-gizmo split — geometry changes happen either pre-edit here or via
 * Cmd+Drag move).
 */
export function resolveGizmoTargetLayer(e: InteractionEvent): Layer | null {
  const target = e.nativeEvent.target as HTMLElement | null;
  if (!target) return null;
  const host = target.closest('[data-overlay-gizmo-layer]');
  const layerId = host?.getAttribute('data-overlay-gizmo-layer');
  if (!layerId) return null;
  const layer = e.activeFrame.layers.byId[layerId];
  return layer && layer.type === 'text' ? layer : null;
}
