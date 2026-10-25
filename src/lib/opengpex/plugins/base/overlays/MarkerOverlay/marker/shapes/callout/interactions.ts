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
 * Callout tail-tip drag. Lives with the shape; the plugin registers it through
 * `CalloutDefinition.interactions`.
 */

import type { InteractionEvent, InteractionHandler, Layer } from '@opengpex/editor/core/types';
import { asLocalShape } from '@opengpex/editor/core/types';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { CraftDrawerAPI } from '../../../../../drawers/CraftDrawer/protocols';
import type { CalloutMarkerData } from '../../types';
import { layoutCallout } from './geometry';
import { CALLOUT_TAIL_HANDLE_ATTR } from './TailHandle';

const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;

/** The layer world matrix type as exposed by the GeometryService (plugins never import geometry operators). */
type LayerMatrix = ReturnType<InteractionEvent['geometry']['transform']['getLayerWorldMatrix']>;

/**
 * Priority 162: between resize (160) and rotate (165) — the tail knob is a DOM
 * element, so hitting it must beat the body-move hit test, and it never overlaps
 * the rotate knob (which floats above the top edge).
 *
 * Geometry is solved in the layer's frame at gesture start: the pointer's world
 * position is pulled through the inverse of the start world matrix into that
 * frame (top-left origin, unrotated), the body stays put, the tip follows the
 * pointer, and `layoutCallout` yields the new bounding plus body/tip relative to
 * it. The new world centre is the new bounding's centre pushed back through the
 * SAME start matrix — so rotation and mirroring need no special casing.
 */
export const createCalloutTailHandler = (): InteractionHandler => {
  let layerId: string | null = null;
  let startData: CalloutMarkerData | null = null;
  let startWorld: LayerMatrix | null = null;
  let startInverse: LayerMatrix | null = null;
  let tx: InteractionTransaction | null = null;

  const activeCallout = (e: InteractionEvent): Layer | null => {
    const frame = e.activeFrame;
    const id = frame.activeLayerId;
    const layer = id ? frame.layers.byId[id] : null;
    return layer && layer.type === 'vector' && layer.markerData?.kind === 'callout' ? layer : null;
  };

  return {
    id: 'marker-callout-tail',
    priority: 162,

    test: (e) => {
      if (e.state.interaction.interactionMode !== 'craft') return false;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'marker') return false;
      const target = e.nativeEvent.target as HTMLElement | null;
      if (!target?.closest(`[${CALLOUT_TAIL_HANDLE_ATTR}]`)) return false;
      return !!activeCallout(e);
    },

    onStart: (e) => {
      const layer = activeCallout(e);
      if (!layer) return;
      layerId = layer.id;
      startData = layer.markerData as CalloutMarkerData;
      startWorld = e.geometry.transform.getLayerWorldMatrix(layer);
      startInverse = startWorld.inverse();

      tx = new InteractionTransaction(e, { useIncreComp: true });
      tx.begin(false);
      e.actions.fast.cursor.notifyDragging('move');
    },

    onMove: (e) => {
      if (!layerId || !startData || !startWorld || !startInverse || !tx) return;
      const tipInStartFrame = startInverse.apply({ x: e.point.world.x, y: e.point.world.y });
      const layout = layoutCallout(startData.body, tipInStartFrame, startData.stroke.width);
      const worldCenter = startWorld.apply(layout.center);

      tx.update({
        cx: worldCenter.x,
        cy: worldCenter.y,
        bounding: layout.bounding,
        visibleShape: asLocalShape({ x: 0, y: 0, w: layout.bounding.w, h: layout.bounding.h }),
        markerData: { ...startData, body: layout.body, tip: layout.tip },
      }, 'layer', layerId);
    },

    onEnd: (e) => {
      tx?.commit();
      tx = null;
      layerId = null;
      startData = null;
      startWorld = null;
      startInverse = null;
      e.actions.fast.cursor.notifyDragging(null);
    },

    onCancel: (e) => {
      tx?.abort();
      tx = null;
      layerId = null;
      startData = null;
      startWorld = null;
      startInverse = null;
      e.actions.fast.cursor.notifyDragging(null);
    },
  };
};
