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
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Canvas stage filter — the stage's OWN generic "omit these layers from the
 * composited frame" capability, published through the interaction-signal
 * channel by ANY session that presents some layers elsewhere (the animation
 * playback overlay is the first consumer; the stage never knows why).
 *
 * Direction discipline: the stage only ever READS this key. Publishers (a
 * playback session, a future video layer, ...) write the layer-id array on
 * session start and clear it on session end. This keeps the stage free of
 * any playback/sequence vocabulary — the 2026-11-16 review rejected the
 * earlier `playback.activeSequenceId` key precisely because it made the core
 * stage component aware of a sibling pipeline's existence.
 */

import type { Layer } from '@opengpex/editor/core/types';

/** Interaction-signal key: array of layer ids to omit from the stage frame. */
export const STAGE_OMITTED_LAYERS_SIGNAL_KEY = 'stage.omittedLayers';

/** Structural subset the helper needs (generic so Frame in → Frame out). */
interface FrameLike {
  layers: { byId: Record<string, Layer>; order: string[] };
}

/**
 * A frame copy with every layer whose id is listed REMOVED. The caller must
 * memoize so the reference stays stable across ticks (a stable layers ref
 * keeps the stage's render caches warm — one rebuild on publish, none after).
 * Null/empty ids → the frame passes through untouched.
 */
export function omittedLayers<T extends FrameLike>(frame: T | null, omittedIds: readonly string[] | null): T | null {
  if (!frame || !omittedIds || omittedIds.length === 0) return frame;
  const omit = new Set(omittedIds);
  const byId: Record<string, Layer> = {};
  const order: string[] = [];
  for (const id of frame.layers.order) {
    const layer = frame.layers.byId[id];
    if (!layer || omit.has(id)) continue;
    byId[id] = layer;
    order.push(id);
  }
  return { ...frame, layers: { byId, order } };
}
