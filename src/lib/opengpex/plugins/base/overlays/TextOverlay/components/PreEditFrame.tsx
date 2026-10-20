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

'use client';

import React from 'react';
import { useEditorState, useOverlayRotationSync } from '@opengpex/editor/core/context';
import { TransformGizmo } from '@opengpex/editor/widgets/TransformGizmo';
import { usePreEditFrameSync } from '../useFastSync';
import { TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID } from '../protocols';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import type { Layer } from '@opengpex/editor/core/types';

/**
 * PreEditFrame: the text tool's self-drawn pre-edit frame over the ACTIVE text
 * layer (LayerOverlay draws no text gizmos — the old usage/gizmoTypes channel
 * has been removed along with the whole LayerOverlay usage registry).
 *
 * The frame is dual-purpose, crop-mark style, with all handle visuals and hit
 * zones supplied by the shared TransformGizmo widget (corner brackets that
 * are themselves diagonal resize handles, edge ticks, rotation handle).
 *
 * Interaction contract with the interaction handlers is unchanged: the gizmo
 * handles carry the same data attributes they had inside LayerOverlayItem, and
 * the frame box itself carries `data-overlay-gizmo-layer={layer.id}` so
 * resolveGizmoTargetLayer keeps resolving the owning layer. Position/size is
 * maintained outside React by usePreEditFrameSync (60fps camera + live-resize
 * following), like MarkerSelectionBox.
 *
 * Display scope: the ACTIVE layer gets the full interactive gizmo. Every OTHER
 * visible text layer gets a visual-only corner bracket ghost (no hit zones,
 * no interaction) so all text boxes read as text at a glance — the same
 * "this is a text box" cue the active frame gives, minus the affordance.
 */
export const PreEditFrame = React.memo(function PreEditFrame() {
  const { activeFrame, activeCraft, editingLayerId } = useTextOverlayGate();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);

  const activeLayer: Layer | null = activeFrame?.activeLayerId
    ? activeFrame.layers.byId[activeFrame.activeLayerId] ?? null
    : null;
  const isText = !!activeLayer && activeLayer.type === 'text' && !!activeLayer.textData && activeLayer.visible;
  const layerId = isText ? activeLayer!.id : null;

  usePreEditFrameSync(boxRef, layerId);
  useOverlayRotationSync(containerRef, activeFrame);

  if (!activeFrame || activeCraft !== 'text' || editingLayerId) return null;

  const layer = activeLayer;
  // Handle cursors only render inside the guarded active-frame block, where
  // the layer is guaranteed present — default to 0° for the type-checker.
  const rotation = layer?.rotation ?? 0;
  const flip = layer?.flip;

  // Visual-only ghosts: every other visible text layer shows plain corner
  // brackets (no hit zones — nothing interactive, pure affordance cue).
  const ghostLayers = activeFrame.layers.order
    .map((id) => activeFrame.layers.byId[id])
    .filter(
      (l): l is Layer =>
        !!l && l.type === 'text' && !!l.textData && l.visible && l.id !== layerId,
    );

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none overflow-visible"
      // Above the whole LayerOverlay stack (its active item sits at zIndex 10
      // inside its own container) so the frame and handles are never painted
      // under the hover outlines / index labels.
      style={{ zIndex: 20 }}
    >
      {ghostLayers.map((ghost) => (
        <PreEditGhost key={ghost.id} layerId={ghost.id} />
      ))}

      {!layerId ? null : (
      <div
        ref={boxRef}
        data-overlay-gizmo-layer={layerId}
        className="absolute top-0 left-0"
        style={{ display: 'none', transformOrigin: '0 0', willChange: 'transform, width, height' }}
      >
        <TransformGizmo rotation={rotation} flip={flip} />
      </div>
      )}
    </div>
  );
});

/**
 * PreEditGhost: visual-only corner brackets over a NON-active text layer.
 * No hit zones, no handles — the ghost is pure affordance ("this is a text
 * box"), so it must never intercept a click meant for the canvas beneath
 * (selection / creation). Camera+pose following reuses usePreEditFrameSync
 * with its own box ref, one fast-sync subscription per ghost.
 */
function PreEditGhost({ layerId }: { layerId: string }) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  usePreEditFrameSync(boxRef, layerId);
  return (
    <div
      ref={boxRef}
      data-text-preedit-ghost={layerId}
      className="absolute top-0 left-0 pointer-events-none"
      style={{ display: 'none', transformOrigin: '0 0', willChange: 'transform, width, height' }}
    >
      <TransformGizmo visualOnly />
    </div>
  );
}

/**
 * Narrow state gate for the pre-edit frame: reads the same signals as
 * useTextOverlayState but without its cursor/hover side effects, so mounting
 * the frame stays side-effect free.
 */
function useTextOverlayGate() {
  const { state, activeFrame } = useEditorState();
  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft] as string | null;
  const editingLayerId = state.interaction.signals[TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID] as string | null;
  return { activeFrame, activeCraft, editingLayerId };
}
