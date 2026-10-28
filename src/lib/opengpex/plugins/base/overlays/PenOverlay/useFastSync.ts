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

import { useEffect, useRef } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import type { CameraState, Frame, Layer, VolatileState } from '@opengpex/editor/core/types';
import {
  composePenToolState,
  getPenDraftSelection,
  getPenSelectionVersion,
  getPenWorkVersion,
  placePenRubberTip,
  refreshPenAnchorHover,
} from './interactions';
import { buildPenOverlaySvg, canvasToScreen, getPenRubberTip } from './pen/render';

/**
 * usePenSurfaceSync: drives the pen tool's SVG surface.
 *
 * The surface is a viewport-sized, UNSCALED SVG: the fragment is rebuilt in
 * screen px whenever the draft work version, the selection version, the
 * frame identity OR the camera changes (points are projected through the
 * camera at build time, so camera moves must repaint — no CSS transform is
 * involved; see render.ts for why). The draft payload itself is read from
 * the frame's drafts channel (persisted) plus the gesture working copy
 * (module store) — useFastSync only lends its ticker beat. The rebuild is a
 * small string join (typical paths hold tens of anchors), safe at the 60Hz
 * ticker cadence.
 *
 * `outlineOnly` (pen tool INACTIVE) draws the persisted draft as a bare
 * outline — the Photoshop Work Path behavior: the draft stays visible in
 * every other tool so the user never loses track of it, but no anchors,
 * handles or committed-path edit affordances are drawn. The rubber band tip
 * and hover re-apply are skipped in this mode (both are edit affordances).
 */
export function usePenSurfaceSync(
  containerRef: React.RefObject<HTMLDivElement | null>,
  groupRef: React.RefObject<SVGGElement | null>,
  isActive: boolean,
  outlineOnly = false,
) {
  const { geometry } = useEditorServices();
  const lastWorkVersionRef = useRef<number>(-1);
  const lastSelectionRef = useRef<number>(-1);
  const lastFrameRef = useRef<Frame | null>(null);
  const lastCamRef = useRef<{ x: number; y: number; k: number } | null>(null);
  // The mode flag rides a ref (not the tick closure) so a tool enter/exit is
  // seen even if the ticker still holds the previous callback identity.
  const outlineRef = useRef<boolean>(outlineOnly);
  const lastOutlineRef = useRef<boolean>(outlineOnly);
  // Effect (not render) write: react-hooks/refs forbids mutating refs during
  // render, and the ticker reads this on the following frame anyway.
  useEffect(() => { outlineRef.current = outlineOnly; }, [outlineOnly]);

  useFastSync(containerRef, isActive, (_v: VolatileState, f: Frame, cam: CameraState) => {
    const g = groupRef.current;
    if (!g) return;
    const outline = outlineRef.current;

    const camChanged = !lastCamRef.current ||
      lastCamRef.current.x !== cam.x ||
      lastCamRef.current.y !== cam.y ||
      lastCamRef.current.k !== cam.k;
    if (camChanged) lastCamRef.current = { x: cam.x, y: cam.y, k: cam.k };

    // A tool enter/exit flips the render mode (anchors vs bare outline) —
    // force one rebuild even when nothing else moved.
    const modeChanged = lastOutlineRef.current !== outline;
    lastOutlineRef.current = outline;

    const workVersion = getPenWorkVersion();
    const selectionVersion = getPenSelectionVersion();
    // The frame object changes identity whenever Redux commits anything on
    // it (a draft write, layer moves, visibility, penData patches) — all must
    // repaint the committed paths even though the module versions did not
    // move.
    const frameChanged = lastFrameRef.current !== f;
    lastFrameRef.current = f;
    if (!camChanged && !frameChanged && !modeChanged && workVersion === lastWorkVersionRef.current && selectionVersion === lastSelectionRef.current) return;
    lastWorkVersionRef.current = workVersion;
    lastSelectionRef.current = selectionVersion;

    // Only structural changes and camera moves reach this ticker: the
    // rubber band follows the pointer directly in the pointermove listener
    // (see movePenRubberTip), with NO clock dependency. Its start point is
    // re-placed here in screen px alongside the fragment.
    const toolState = composePenToolState(f);
    g.innerHTML = buildPenOverlaySvg(
      toolState,
      collectCommittedPenLayers(f),
      cam,
      f,
      (layer, frame) => geometry.transform.getLayerLocalMatrix(layer, frame),
      outline ? null : getPenDraftSelection(),
      (path, map) => geometry.bezier.mapPathAnchors(path, map),
      outline,
    );
    if (outline) return;
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
