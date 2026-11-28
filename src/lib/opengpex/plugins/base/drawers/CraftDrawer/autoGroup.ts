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
 * Craft-family auto grouping: the shared placement facility every craft
 * overlay's place command runs before inserting its freshly built layer.
 *
 * Problem it solves: each craft act (brush stroke, text box, marker, pen
 * shape) commits its own lightweight layer; after a dozen consecutive acts
 * the layers panel balloons. Grouping the marks into ONE collapsed container
 * keeps the panel at a single row while preserving every per-layer property
 * (the group is purely organizational — members hang off it through
 * `groupId` and keep their own opacity/blend/transform).
 *
 * Membership is policy, not mechanism: only craft tools whose every act
 * spawns an overlay mark layer participate. Bakes (heal/mosaic/clone/
 * blur/sharpen), content layers (imports, color fills) and host-bound
 * sub-layers (triplet masks, cut fragments) never join.
 */

import { Frame, Layer } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';

/** Marker value stored on an auto group's `metadata.autoGroup`. */
export type AutoGroupKind = 'craft';

/**
 * Craft tools whose every act spawns its own overlay mark layer. Single
 * source of truth for session membership, owned by the CraftDrawer hub —
 * overlays must not re-derive this set. Legacy text layers predate the
 * 'basic-text' stamp; the type is producer-unique so absence of the stamp
 * still resolves identity (see `isAutoGroupMember`).
 */
const AUTO_GROUP_SOURCE_TOOLS = new Set(['brush', 'basic-text', 'marker', 'pen']);

/**
 * Whether a layer participates in craft auto grouping.
 *
 * Host-bound sub-layers (triplet masks, cut fragments) are never session
 * marks — they carry `hostId` attachment semantics and must not be pulled
 * into an auto group. A stamped `sourceTool` decides membership; only an
 * UNSTAMPED `type:'text'` layer falls back to membership (producer-unique
 * type, so the absence of the stamp still resolves identity).
 */
export function isAutoGroupMember(layer: Layer): boolean {
  if (layer.hostId) return false;
  const tool = layer.metadata?.sourceTool;
  if (tool != null) return AUTO_GROUP_SOURCE_TOOLS.has(tool);
  return layer.type === 'text';
}

/** Reads the CRAFT auto group this layer belongs to (itself, when it IS the group). */
function autoGroupOf(frame: Frame, layer: Layer): Layer | undefined {
  if (layer.type === 'group' && layer.metadata?.autoGroup === 'craft') return layer;
  if (!layer.groupId) return undefined;
  const group = frame.layers.byId[layer.groupId];
  return group?.metadata?.autoGroup === 'craft' ? group : undefined;
}

/** Base name for auto-created groups (incremented by the naming service). */
const AUTO_GROUP_BASE_NAME = 'Drawing Group';

/** Placement instructions the caller executes IN ORDER, on the stale frame indices. */
export interface AutoGroupPlacement {
  /**
   * Group to CREATE FIRST when the incoming layer forms a new auto group
   * (second consecutive member). Insert it at `insertAt` BEFORE adding the
   * incoming layer.
   */
  group?: { layer: Layer; insertAt: number };
  /**
   * Migration for the EXISTING top-level member that the new group wraps
   * (case B only): apply as `updateLayer(layerId, { groupId })` in the same
   * undoable step, BEFORE the incoming layer's `addLayer` so the panel never
   * renders the member outside its own group.
   */
  hostPatch?: { layerId: string; groupId: string };
  /** `groupId` to stamp on the incoming layer (new or existing auto group, or an inherited manual group). */
  groupId?: string;
  /** Insert index for the incoming layer. `undefined` = append on top of the stack. */
  insertAt?: number;
}

/**
 * Resolves where a freshly built craft layer lands: plain above the active
 * layer, absorbed into an existing auto group, or packed with the active
 * top-level member into a NEW collapsed auto group.
 *
 * Pure and read-only: all indices are computed from the `frame` snapshot
 * PASSED IN. This is deliberate — the store reducer is immutable, so once
 * the caller's first `addLayer` dispatch lands, any frame reference the
 * caller captured is stale and recomputing indices against it shifts every
 * insert by one (the new layer would land between the group header and its
 * first member, inverting the z-order). Both returned indices are therefore
 * exact against the snapshot and stay exact after the intermediate group
 * insert (`group.insertAt <= insertAt` by construction, so the group's
 * splice shifts the incoming layer's slot by exactly the +1 already baked
 * into the arithmetic below).
 *
 * The caller stamps `placement.groupId` onto the layer before `addLayer`
 * (the facility mutates nothing on the incoming layer).
 */
export function resolveAutoGroupPlacement(frame: Frame): AutoGroupPlacement {
  const activeId = frame.activeLayerId;
  const active = activeId ? frame.layers.byId[activeId] : undefined;
  // Triplet sub-layers (mask attachments) resolve to their host so a new
  // mark is never wedged inside a triplet (same rule as plain placement).
  const host = active?.hostId ? (frame.layers.byId[active.hostId] ?? undefined) : active;

  if (!host) {
    // No active layer: append on top of the stack, no group.
    return { insertAt: undefined };
  }

  // ── Case A · the active layer lives in (or is) an auto group ──
  const existingGroup = autoGroupOf(frame, host);
  if (existingGroup) {
    return {
      groupId: existingGroup.id,
      // Above the active member (or above the group's top member when the
      // active layer IS the group head) — `getInsertIndexAbove` handles both
      // the group target and the host's trailing hostId children.
      insertAt: LayerFactory.getInsertIndexAbove(frame, host.id),
    };
  }

  // ── Case B · the active layer is a TOP-LEVEL member: form a new group ──
  if (isAutoGroupMember(host) && !host.groupId) {
    const activeIdx = frame.layers.order.indexOf(host.id);
    const group = LayerFactory.createLayer('group', {
      name: LayerFactory.getNewLayerNameFor(frame, AUTO_GROUP_BASE_NAME),
      collapsed: true,
      metadata: { autoGroup: 'craft' satisfies AutoGroupKind },
    });
    // Group header sits at the member-block BOTTOM: at the active layer's
    // index, pushing the active layer (and its trailing hostId children)
    // one slot up. The incoming layer goes above that shifted block:
    // `getInsertIndexAbove` already skipped the hostId children, so the +1
    // compensates exactly for the group's splice (groupAt < base by
    // construction).
    const base = LayerFactory.getInsertIndexAbove(frame, host.id);
    return {
      group: { layer: group, insertAt: activeIdx },
      hostPatch: { layerId: host.id, groupId: group.id },
      groupId: group.id,
      // `base` can be undefined only when the host record vanished from the
      // order array mid-session; falling back past the group keeps the layer
      // directly above the header instead of silently appending elsewhere.
      insertAt: base !== undefined ? base + 1 : activeIdx + 1,
    };
  }

  // ── Case C · everything else ──
  // Inside a user-built manual group: inherit the membership (fixes the
  // historical quirk where a new mark landed inside the group's order range
  // without being a member). Otherwise plain insertion above the active
  // layer; group / hostId targets are handled by `getInsertIndexAbove`.
  if (host.groupId && frame.layers.byId[host.groupId]) {
    return {
      groupId: host.groupId,
      insertAt: LayerFactory.getInsertIndexAbove(frame, host.id),
    };
  }
  return { insertAt: LayerFactory.getInsertIndexAbove(frame, host.id) };
}
