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
 * PenRotateHandler (priority 166) — drag the pen gizmo's rotation handle to
 * rotate the active pen layer. A THIN DECLARATION over the shared
 * `createGizmoRotateHandler` (the retired hand-rolled copy's specialization):
 *   - scope: the pen gizmo's rotation dot;
 *   - admission: pen craft mode + the ACTIVE layer, gated to the pen payload
 *     kind (vector layer carrying penData);
 *   - incremental compositing declared (marker/pen precedent — pen layers
 *     write through the incre-comp channel).
 *
 * Rotation rides the LAYER channel only — `layer.rotation` is written and
 * penData is untouched: every penData consumer (face renderer, pen-edit hit
 * tests, PenGizmo sync, the SVG overlay) already resolves coordinates through
 * the layer matrix, so the payload needs no rewrite.
 */

import type { InteractionEvent, InteractionHandler, Layer } from '@opengpex/editor/core/types';
import { createGizmoRotateHandler } from '@opengpex/editor/stage/interaction/handlers/GizmoRotateHandler';
import { ACTIVE_CRAFT_KEY } from './shared';

export const createPenRotateHandler = (): InteractionHandler =>
  createGizmoRotateHandler({
    id: 'pen-rotate',
    priority: 166,
    scopeSelector: '[data-pen-gizmo] [data-gizmo-rotate]',
    admit: (e: InteractionEvent): Layer | null => {
      if (e.state.interaction.interactionMode !== 'craft') return null;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'pen') return null;
      const frame = e.activeFrame;
      const activeId = frame.activeLayerId;
      const layer = activeId ? frame.layers.byId[activeId] : null;
      if (!layer || layer.type !== 'vector' || !layer.penData) return null;
      return layer;
    },
    useIncreComp: true,
  });
