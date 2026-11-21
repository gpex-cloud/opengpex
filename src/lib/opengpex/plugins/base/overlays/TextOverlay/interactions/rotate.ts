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
 * TextRotateHandler (priority 165) — drag the text gizmo's rotation handle to
 * rotate the text layer. A THIN DECLARATION over the shared
 * `createGizmoRotateHandler`: the gesture skeleton (atan2 delta, Shift 15°
 * snap, layer-channel write, delta-chip feedback) lives there once — the
 * retired hand-rolled copy is byte-for-byte its specialization with these
 * three domain facts:
 *   - scope: the text gizmo's rotation dot;
 *   - admission: text craft mode + the gizmo's bound layer (must be a text
 *     layer — resolveGizmoTargetLayer enforces the payload kind);
 *   - plain transaction (text layers composite without the incre-comp
 *     channel, unlike marker/pen).
 *
 * Priority 165 (> TextResizeHandler 160 > TextPlaceHandler 150): a pointerdown
 * on the rotate handle must win over resize / place.
 */

import type { InteractionEvent, InteractionHandler, Layer } from '@opengpex/editor/core/types';
import { createGizmoRotateHandler } from '@opengpex/editor/stage/interaction/handlers/GizmoRotateHandler';
import { ACTIVE_CRAFT_KEY, resolveGizmoTargetLayer } from './shared';

export const createTextRotateHandler = (): InteractionHandler =>
  createGizmoRotateHandler({
    id: 'text-rotate',
    priority: 165,
    scopeSelector: '[data-text-gizmo] [data-gizmo-rotate]',
    admit: (e: InteractionEvent): Layer | null => {
      if (e.state.interaction.interactionMode !== 'craft') return null;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'text') return null;
      return resolveGizmoTargetLayer(e);
    },
  });
