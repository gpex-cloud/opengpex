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
 * fragmentPose.ts — pure pose math for free-transforming a FRAGMENT layer
 * (peel exchange): corner scaling with a diagonal anchor and rotation about
 * the content box center. Every function is stateless (recomputed from the
 * GESTURE-START pose each pointermove, never incremented) so a stale or
 * dropped pointer event can never accumulate drift.
 *
 * Geometry model — the three boxes of a fragment layer:
 *
 *   The layer's `bounding` box is what `computeWorldMatrix` centers on
 *   (cx, cy). The VISIBLE content is the `visibleShape` crop, drawn at offset
 *   (vx, vy) = visibleShape.rect.x/y inside the bounding box (see
 *   `LayerUtils.getMaskOrigin` for the painter contract). For a peeled
 *   exchange the crop size equals the bounding size, but the offset (vx, vy)
 *   is generally NON-zero — the crop lives inside the SHARED source asset, so
 *   the bounding box and the visible content box are the same size yet
 *   displaced. The user grabs the CONTENT box (what they see), so every
 *   anchor / center / ROI below is expressed on the content box:
 *
 *     content center (world) = (cx, cy) + O · S · (vx, vy)
 *     content corners        = center ± O · S · (w/2, h/2)
 *
 *   where O = getOrientationMatrix(rotation, flip) and S = diag(scale,
 *   scaleY) is the gesture scale (identity outside a transform gesture —
 *   `Layer.scale` is deprecated and never carries rendering semantics).
 *
 * All inputs/outputs are WORLD coordinates (the same space as layer.cx/cy —
 * the canvas center origin). Callers convert pointer positions with
 * `geometry.space.localToWorld` / back with `worldToLocal`.
 */

import { Matrix3x3 } from '../matrix';
import { getOrientationMatrix } from './transform';
import { snapRotationRad } from './rotator';
import { solveAffineFromTriangles, transformPolygonAffine, layerLocalToFrameLocal } from './polygon';
import { point2dToLocalPolygon } from './point2d';
import type {
  FragmentScaleHandle,
  FragmentPose,
  Frame,
  Layer,
  LocalPolygon,
  Point2D,
  TransformParams,
} from '@opengpex/editor/core/types';

// The pose/gesture vocabulary is DECLARED beside the GeometryService contract
// (core/types/geometry.ts) so plugins consume it through the service; this
// module owns the implementations and re-exports the types for core callers.
export type { FragmentScaleHandle, FragmentPose };

/**
 * The pose's full linear map `O · S · R(−sourceAngle)` — orientation
 * (rotation · flip) composed with the gesture scale, and sourceAngle
 * cancelling the content's tilt INSIDE the bitmap (left by earlier peel
 * bakes) so the stretch acts on the content's own axes. Absent tilt ⇒
 * `R(0)` = identity ⇒ the historical `O · S`, bitwise.
 */
function orientationWithScale(params: FragmentPose): Matrix3x3 {
  const O = getOrientationMatrix(params.rotation, params.flip);
  const S = new Matrix3x3(params.scale, 0, 0, params.scaleY, 0, 0);
  const local = Matrix3x3.rotate(-(params.sourceAngle ?? 0));
  return O.multiply(S).multiply(local);
}

/** World-space center of the visible content box. */
export function getFragmentContentCenter(params: FragmentPose): Point2D {
  const OS = orientationWithScale(params);
  const off = OS.apply(params.visibleOffset);
  return { x: params.cx + off.x, y: params.cy + off.y };
}

/**
 * The four content-box corners in world coords, ordered nw, ne, se, sw
 * (screen convention: nw = smallest x+y in the UNROTATED frame).
 */
export function getFragmentContentCorners(params: FragmentPose): [Point2D, Point2D, Point2D, Point2D] {
  const OS = orientationWithScale(params);
  const c = getFragmentContentCenter(params);
  const hw = params.bounding.w / 2;
  const hh = params.bounding.h / 2;
  const corner = (lx: number, ly: number): Point2D => {
    const p = OS.apply({ x: lx, y: ly });
    return { x: c.x + p.x, y: c.y + p.y };
  };
  return [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)];
}

/**
 * Rotation gesture: the content box spins about ITS OWN center by the
 * pointer's angle delta around that center. The center therefore stays
 * fixed and only (cx, cy) compensates: the visible offset (vx, vy) is
 * expressed in the ROTATING local frame, so the bounding anchor must chase
 * the rotated offset.
 *
 * `shift` snaps to the 15° grid. The grid anchor is `absoluteBaseDeg` —
 * the fragment's TRUE orientation at gesture start (which the layer's
 * `rotation` field alone may not express: a bake moves orientation into
 * pixels and zeroes the field, so the caller supplies the session's
 * accumulated orientation here). Snapping the raw delta instead would
 * strand off-grid accumulated angles (a rotated fragment could never
 * return to upright). The RETURNED rotation is still in layer-field
 * space (startRotationDeg + snapped delta); only the GRID is absolute.
 */
export function computeFragmentRotation(
  start: FragmentPose,
  pointerWorld: Point2D,
  startRotationDeg: number,
  startPointerAngleRad: number,
  opts?: { shift?: boolean; absoluteBaseDeg?: number },
): TransformParams {
  const center = getFragmentContentCenter(start);
  const angle = Math.atan2(pointerWorld.y - center.y, pointerWorld.x - center.x);
  let deltaRad = angle - startPointerAngleRad;
  if (opts?.shift) {
    deltaRad = snapRotationRad(deltaRad, ((opts.absoluteBaseDeg ?? startRotationDeg) * Math.PI) / 180);
  }
  const rotation = startRotationDeg + (deltaRad * 180) / Math.PI;

  const OS = orientationWithScale({ ...start, rotation });
  const visOff = OS.apply(start.visibleOffset);
  return { cx: center.x - visOff.x, cy: center.y - visOff.y, rotation };
}

 /**
 * World-space AABB of the transformed content box, expanded by `pad` on
 * every side and snapped OUTWARD to whole pixels (floor/ceil) — the bake
 * ROI must cover every transformed texel, and a pixel-aligned ROI keeps the
 * composite's own ceil() rounding from shaving the soft edge.
 */
export function getFragmentBakeRoi(params: FragmentPose, pad = 0): { x: number; y: number; w: number; h: number } {
  const corners = getFragmentContentCorners(params);
  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  const minX = Math.floor(Math.min(...xs) - pad);
  const minY = Math.floor(Math.min(...ys) - pad);
  const maxX = Math.ceil(Math.max(...xs) + pad);
  const maxY = Math.ceil(Math.max(...ys) + pad);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Reads the `FragmentPose` of a fragment layer at gesture start.
 * `scale` is always 1 here: a previous gesture's magnification was baked
 * into the pixels at commit ("松手即烘焙"), so a live session pose never
 * carries residual scale.
 */
export function fragmentPoseFromLayer(layer: {
  cx: number;
  cy: number;
  rotation: number;
  flip: { h: boolean; v: boolean };
  bounding: { w: number; h: number };
  visibleShape?: { rect?: { x: number; y: number; w?: number; h?: number } } | null;
}): FragmentPose {
  return {
    cx: layer.cx,
    cy: layer.cy,
    rotation: layer.rotation,
    flip: { ...layer.flip },
    bounding: { ...layer.bounding },
    visibleOffset: {
      x: layer.visibleShape?.rect?.x ?? 0,
      y: layer.visibleShape?.rect?.y ?? 0,
    },
    scale: 1,
    scaleY: 1,
  };
}

/**
 * The selection follows its peeled fragment: given the fragment's pose at
 * gesture start and at the current/final pose, returns the selection
 * polygon carried by the SAME rigid-plus-scale map that moved the
 * fragment's content box. The map is solved from three content-box corners
 * (start → end) after projecting them into frame-local space, so scaling
 * along the fragment's rotated axes, rotation and mirrored drags all carry
 * over exactly. Degenerate poses (collapsed box) return the selection
 * unchanged.
 */
export function followFragmentSelection(
  selection: LocalPolygon,
  start: FragmentPose,
  end: FragmentPose,
  worldToLocal: (p: Point2D) => Point2D,
): LocalPolygon {
  const [s0, s1, , s3] = getFragmentContentCorners(start).map(worldToLocal);
  const [e0, e1, , e3] = getFragmentContentCorners(end).map(worldToLocal);
  const m = solveAffineFromTriangles([s0, s1, s3], [e0, e1, e3]);
  return m ? transformPolygonAffine(selection, m) : selection;
}

/**
 * migrateFragmentContour: carries the fragment's recorded cut contour
 * (`Layer.contour`, rings in the layer's own plane coordinates) through a
 * transform bake. The bake rewrites the pixel space (fresh asset, rotation
 * zeroed, the plane re-anchored on the composite bounds), so the contour
 * must ride the SAME rigid-plus-scale map that moved the content box from
 * `start` to `end` — the map the bake renders with, solved from three
 * content-box corners exactly like `followFragmentSelection`. The rings are
 * first projected into frame-local space (the space that corner map is
 * solved in), mapped, then shifted into WORLD coordinates (canvas-center
 * origin — the same space as `layer.cx`/`cy` and the bake's composite
 * bounds) so the caller can re-base them onto the new plane origin in one
 * subtraction. Null when the pose map degenerates (collapsed box) — the
 * caller drops the contour rather than recording a wrong line.
 */
export function migrateFragmentContour(
  rings: Point2D[][],
  layer: Layer,
  frame: Frame,
  start: FragmentPose,
  end: FragmentPose,
  worldToLocal: (p: Point2D) => Point2D,
): Point2D[][] | null {
  const [s0, s1, , s3] = getFragmentContentCorners(start).map(worldToLocal);
  const [e0, e1, , e3] = getFragmentContentCorners(end).map(worldToLocal);
  const m = solveAffineFromTriangles([s0, s1, s3], [e0, e1, e3]);
  if (!m) return null;
  const local = transformPolygonAffine(layerLocalToFrameLocal(point2dToLocalPolygon(rings), layer, frame), m).rings;
  // frame-local (canvas top-left origin) → world (canvas-center origin):
  // worldToLocal adds the half-canvas, so its inverse subtracts it.
  const hw = frame.canvas.w / 2;
  const hh = frame.canvas.h / 2;
  return local.map(ring => ring.map(p => ({ x: p.x - hw, y: p.y - hh })));
}
