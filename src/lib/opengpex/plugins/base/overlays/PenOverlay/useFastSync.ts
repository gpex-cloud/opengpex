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

import { useRef } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import type { CameraState, Frame, Layer, VolatileState } from '@opengpex/editor/core/types';
import {
  composePenToolState,
  getPenDraftSelection,
  getPenSelectionVersion,
  placePenRubberTip,
  refreshPenAnchorHover,
} from './interactions';
import { buildPenOverlaySvg, canvasToScreen, getPenRubberTip } from './pen/render';

/**
 * usePenSurfaceSync: drives the pen tool's SVG surface.
 *
 * The surface is a viewport-sized, UNSCALED SVG: the fragment is rebuilt in
 * screen px whenever the scratch version, the selection version OR the
 * camera changes (points are projected through the camera at build time, so
 * camera moves must repaint — no CSS transform is involved; see render.ts
 * for why). The draft payload itself is read from the scratch slot
 * (actions.scratch.get) — useFastSync only lends its ticker beat, no
 * volatile data flows into the pen overlay. The rebuild is a small string
 * join (typical paths hold tens of anchors), safe at the 60Hz ticker cadence.
 */
export function usePenSurfaceSync(
  containerRef: React.RefObject<HTMLDivElement | null>,
  groupRef: React.RefObject<SVGGElement | null>,
  isActive: boolean,
) {
  const { geometry, actions } = useEditorServices();
  const lastScratchVersionRef = useRef<number>(-1);
  const lastSelectionRef = useRef<number>(-1);
  const lastFrameRef = useRef<Frame | null>(null);
  const lastCamRef = useRef<{ x: number; y: number; k: number } | null>(null);

  useFastSync(containerRef, isActive, (_v: VolatileState, f: Frame, cam: CameraState) => {
    const g = groupRef.current;
    if (!g) return;

    const camChanged = !lastCamRef.current ||
      lastCamRef.current.x !== cam.x ||
      lastCamRef.current.y !== cam.y ||
      lastCamRef.current.k !== cam.k;
    if (camChanged) lastCamRef.current = { x: cam.x, y: cam.y, k: cam.k };

    const scratchVersion = actions.scratch.version();
    const selectionVersion = getPenSelectionVersion();
    // The merged frame object changes identity whenever Redux commits layer
    // work (move/delete/visibility/penData patches) or a volatile layer draft
    // exists — both must repaint the committed paths even though the scratch
    // version did not move.
    const frameChanged = lastFrameRef.current !== f;
    lastFrameRef.current = f;
    if (!camChanged && !frameChanged && scratchVersion === lastScratchVersionRef.current && selectionVersion === lastSelectionRef.current) return;
    lastScratchVersionRef.current = scratchVersion;
    lastSelectionRef.current = selectionVersion;

    // Only structural changes and camera moves reach this ticker: the
    // rubber band follows the pointer directly in the pointermove listener
    // (see movePenRubberTip), with NO clock dependency. Its start point is
    // re-placed here in screen px alongside the fragment.
    const toolState = composePenToolState(actions.scratch, f.id);
    g.innerHTML = buildPenOverlaySvg(
      toolState,
      collectCommittedPenLayers(f),
      cam,
      f,
      (layer, frame) => geometry.transform.getLayerLocalMatrix(layer, frame),
      getPenDraftSelection(),
      (path, map) => geometry.bezier.mapPathAnchors(path, map),
    );
    const tip = getPenRubberTip(toolState);
    placePenRubberTip(tip ? canvasToScreen(tip, cam) : null);
    refreshPenAnchorHover();
  }, { throttleHz: 60 });
}

/**
 * The pen-editable layers of a frame. Only HOST (or role-less) layers count —
 * fragment-triplet sub-layers (`frag`/`exchange`) are engine bookkeeping
 * clones that may carry a stale penData copy and must never draw or hit
 * (same convention as the AI executor's layer listing). HIDDEN layers still
 * count: their paths stay on the overlay so a hidden layer's path remains
 * editable (the GPU render is hidden, the geometry is not gone). Locked
 * layers are excluded — locking means "do not touch".
 */
export function collectCommittedPenLayers(f: Frame): Layer[] {
  return f.layers.order
    .map((id) => f.layers.byId[id])
    .filter((l): l is Layer =>
      !!l && l.type === 'vector' && !!l.penData && !l.locked && (!l.role || l.role === 'host'));
}
