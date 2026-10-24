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
 * render.ts — Pure SVG string builders for the pen overlay.
 *
 * The overlay draws in VIEWPORT SCREEN PIXELS inside an unscaled, viewport-
 * sized SVG (the selection-ants convention), NOT in canvas units under a
 * CSS-scaled container like the marker preview. The reason is rasterization:
 * a CSS `scale(k)` on an HTML ancestor is applied to an already-rasterized
 * composited layer, and Chrome caps the raster scale of large layers — at
 * deep zoom a 1.75px/k hairline rasterizes to a fraction of a texel (an
 * aliased dotted trail once magnified), and `vector-effect=
 * "non-scaling-stroke"` cannot help because it only neutralizes transforms
 * INSIDE the SVG. Every point is therefore projected through the camera here
 * and every size is a plain screen px. The fragment is rebuilt on each camera
 * change anyway (the sync's dirty check), so this costs nothing extra.
 * Pure string-in/string-out: trivially testable and free of React coupling.
 *
 * Visual spec (screen px): 1.75px bright path stroke, 7px white anchor
 * squares with 1.5px borders (solid fill when selected), 1.5px handle lines
 * with 5px round tips, 10% fill on closed rings. The rubber band to the
 * cursor is a marching-ants line owned by PenRubberBand.
 */

import type { Frame, IMatrix3x3, Layer, PenAnchor, PenPathData, Point2D } from '@opengpex/editor/core/types';
import { penPathToSvgD } from './svgPath';
import type { PenDraftSelection, PenToolState } from './penState';

const STROKE = '#0d99ff';
const FILL = 'rgba(13, 153, 255, 0.1)';
const SELECTED_FILL = '#0d99ff';

const PATH_STROKE_PX = 1.75;
const MARKER_STROKE_PX = 1.5;
const ANCHOR_SIZE_PX = 7;
const HANDLE_DOT_RADIUS_PX = 2.5;

export type LayerMatrixFn = (layer: Layer, frame: Frame) => IMatrix3x3;
export type PointMap = (p: Point2D) => Point2D;
export interface CameraLike { x: number; y: number; k: number }

const fmt = (v: number): string => String(Math.round(v * 100) / 100);

/** Canvas-local → viewport screen px under the stage camera. */
export function canvasToScreen(p: Point2D, cam: CameraLike): Point2D {
  return { x: cam.x + p.x * cam.k, y: cam.y + p.y * cam.k };
}

function anchorSquare(p: Point2D, selected: boolean, key: string): string {
  const half = ANCHOR_SIZE_PX / 2;
  return `<rect data-pen-anchor="${key}" data-pen-el="${key}" x="${fmt(p.x - half)}" y="${fmt(p.y - half)}" width="${ANCHOR_SIZE_PX}" height="${ANCHOR_SIZE_PX}" fill="${selected ? SELECTED_FILL : '#ffffff'}" stroke="${STROKE}" stroke-width="${MARKER_STROKE_PX}" class="pen-anchor"/>`;
}

function handleGraphics(anchor: PenAnchor, toScreen: PointMap, selected: boolean, keyPrefix: string): string {
  let out = '';
  const a = toScreen({ x: anchor.x, y: anchor.y });
  for (const h of [anchor.handleIn, anchor.handleOut]) {
    if (!h) continue;
    const end = toScreen({ x: anchor.x + h.x, y: anchor.y + h.y });
    const kind = h === anchor.handleIn ? 'in' : 'out';
    out += `<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(end.x)}" y2="${fmt(end.y)}" stroke="${STROKE}" stroke-width="${MARKER_STROKE_PX}"/>`;
    out += `<circle data-pen-handle="${keyPrefix}:${kind}" data-pen-el="h${keyPrefix}:${kind}" class="pen-handle" cx="${fmt(end.x)}" cy="${fmt(end.y)}" r="${HANDLE_DOT_RADIUS_PX}" fill="${selected ? SELECTED_FILL : '#ffffff'}" stroke="${STROKE}" stroke-width="${MARKER_STROKE_PX}"/>`;
  }
  return out;
}

/** One visible path: a single bright stroke (plus the optional ring fill). */
function pathGraphic(d: string, fill: string): string {
  return `<path d="${d}" fill="${fill}" stroke="${STROKE}" stroke-width="${PATH_STROKE_PX}" stroke-linejoin="round" fill-rule="evenodd"/>`;
}

/**
 * Builds the whole overlay fragment in screen px: committed paths first
 * (under), then the active draft (over). Empty string when there is nothing
 * to draw.
 */
export function buildPenOverlaySvg(
  state: PenToolState,
  committedLayers: Layer[],
  cam: CameraLike,
  frame: Frame,
  getLayerMatrix: LayerMatrixFn,
  draftSelected?: PenDraftSelection | null,
  /** The L0 anchor-map op (handles re-basing) — injected by the caller. */
  mapPathAnchors?: (path: PenPathData, map: PointMap) => PenPathData,
): string {
  const mapOps = mapPathAnchors ?? ((path: PenPathData, map: PointMap) => ({
    paths: path.paths.map((sub) => ({
      closed: sub.closed,
      anchors: sub.anchors.map((a) => {
        const p = map({ x: a.x, y: a.y });
        const rel = (h: { x: number; y: number } | null | undefined) => {
          if (!h) return h;
          const e = map({ x: a.x + h.x, y: a.y + h.y });
          return { x: e.x - p.x, y: e.y - p.y };
        };
        return { x: p.x, y: p.y, handleIn: rel(a.handleIn), handleOut: rel(a.handleOut) };
      }),
    })),
  }));
  const canvasToView: PointMap = (p) => canvasToScreen(p, cam);
  let svg = '';

  // ── Committed pen layers: curves + unselected anchors; handles only for
  //    the selected anchor (Illustrator's keep-the-noise-down convention).
  for (const layer of committedLayers) {
    const matrix = getLayerMatrix(layer, frame);
    const toScreen: PointMap = (p) => canvasToView(matrix.apply(p));
    const data: PenPathData = layer.penData!;
    const d = penPathToSvgD({
      paths: mapOps(data, toScreen).paths,
    });
    if (d) svg += pathGraphic(d, FILL);
    const selected = state.selected;
    for (let pi = 0; pi < data.paths.length; pi++) {
      const sub = data.paths[pi];
      for (let ai = 0; ai < sub.anchors.length; ai++) {
        const a = sub.anchors[ai];
        const isSel = selected && selected.pathIdx === pi && selected.anchorIdx === ai;
        if (isSel) svg += handleGraphics(a, toScreen, true, `c:${layer.id}:${pi}:${ai}`);
        svg += anchorSquare(toScreen({ x: a.x, y: a.y }), !!isSel, `c:${layer.id}:${pi}:${ai}`);
      }
    }
  }

  // ── Draft session (canvas-local): every anchor with its handles, the
  //    selected draft anchor solid.
  if (state.draft) {
    for (let pi = 0; pi < state.draft.subpaths.length; pi++) {
      const sub = state.draft.subpaths[pi];
      if (sub.anchors.length === 0) continue;
      const d = penPathToSvgD({ paths: [mapOps({ paths: [sub] }, canvasToView).paths[0]] });
      if (d) svg += pathGraphic(d, sub.closed ? FILL : 'none');
      for (let ai = 0; ai < sub.anchors.length; ai++) {
        const a = sub.anchors[ai];
        const isSel = !!draftSelected && draftSelected.pathIdx === pi && draftSelected.anchorIdx === ai;
        svg += handleGraphics(a, canvasToView, isSel, `d:${pi}:${ai}`);
        svg += anchorSquare(canvasToView(a), isSel, `d:${pi}:${ai}`);
      }
    }
  }

  return svg;
}

/**
 * Canvas-local start point of the rubber band (the open draft subpath's
 * last anchor), or null when no band should show. The band is a persistent
 * element outside the rebuilt fragment (see PenRubberBand) so the pointer
 * listener can move its tip without a rebuild.
 */
export function getPenRubberTip(state: PenToolState): Point2D | null {
  if (!state.draft) return null;
  const last = state.draft.subpaths[state.draft.subpaths.length - 1];
  if (!last || last.closed || last.anchors.length === 0) return null;
  const tip = last.anchors[last.anchors.length - 1];
  return { x: tip.x, y: tip.y };
}
