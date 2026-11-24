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

import { Matrix3x3, GeometryOp } from '../matrix';
import { computePolygonBounds } from './polygon';
import { Layer, Frame, IMatrix3x3, asLocalRect, asLocalPoint, asLocalPolygon, LocalPolygon, LayerPoseOverride, Point2D, Dimensions } from '@opengpex/editor/core/types';
/**
 * [Generic] Core geometric operator: calculate transform matrix of any asset in world coordinate system
 *
 * Design contract:
 *   Matrix = Translate(cx, cy) × Orientation(rotation, flip) × Scale(sx, sy) × Translate(-bounding.w/2, -bounding.h/2)
 *
 * This places the center of the layer's BOUNDING BOX at world coordinate (cx, cy).
 * The painter (painter.ts) then draws content at visibleShape.rect offset (vx, vy) within
 * this bounding-local coordinate space, so content naturally appears at its correct position.
 *
 * The scale factors come from a `LayerPoseOverride` ONLY — `Layer.scale` is a
 * deprecated, constantly-1.0 field and must never gain rendering semantics.
 * Scale is applied about the bounding center (it commutes with the flip
 * mirror because both are diagonal matrices), so a fragment gesture scales
 * the content around (cx, cy) and the caller re-anchors (cx, cy) to keep the
 * gesture's anchor corner fixed.
 *
 * [Historical note / Bugfix 2026-07-04]
 * Previously this function used visibleShape.rect for centering and included a -rect.x/-rect.y
 * "compensation" translation. That design caused imported images with non-zero contentBounds
 * (e.g., images with transparent borders) to have their visible content forced to canvas center
 * instead of appearing at its true position. The fix: always center on bounding, let the painter
 * handle visibleShape offset naturally via drawImage(source, vx, vy, vw, vh, vx, vy, vw, vh).
 *
 * Safe because all existing fragment layers have visibleShape.rect at (0, 0) — the old
 * compensation was always a no-op for them.
 */
function computeWorldMatrix(props: {
  cx: number;
  cy: number;
  rotation: number;
  flip: { h: boolean; v: boolean };
  bounding: { w: number; h: number };
  scale?: number;
  scaleY?: number;
  sourceAngle?: number;
}): Matrix3x3 {
  const { cx, cy, rotation, flip, bounding } = props;

  const sx = props.scale ?? 1;
  const sy = props.scaleY ?? props.scale ?? 1;
  const S = (sx === 1 && sy === 1)
    ? Matrix3x3.identity()
    : new Matrix3x3(sx, 0, 0, sy, 0, 0);
  // sourceAngle: the content's tilt inside the bitmap — cancelled BEFORE
  // the stretch so axis factors act on the content's own axes (linear part
  // `O · S · R(−sourceAngle)`). 0 ⇒ R(0) = identity ⇒ the historical
  // matrix, bitwise.
  const L = Matrix3x3.rotate(-(props.sourceAngle ?? 0));

  return Matrix3x3.translate(cx, cy)
    .multiply(getOrientationMatrix(rotation, flip))
    .multiply(S)
    .multiply(L)
    .multiply(Matrix3x3.translate(-bounding.w / 2, -bounding.h / 2));
}

/**
 * [External] Convert semantic state to 2x2 rotation-mirror matrix part
 *
 * Contract: **O = R × F** (mirror first, then rotate), rotation in degrees.
 * This is THE single source of truth for orientation sign convention across
 * rendering (`computeWorldMatrix`), move (`computeLayerMovePose`), resize
 * (`localToWorldCenter` in space.ts) and snapping (`snapEdgeRotated`). Any
 * hand-rolled sin/cos that disagrees with it will mirror the result relative to
 * what the user sees on screen — always call this instead of re-deriving it.
 */
export function getOrientationMatrix(rotation: number, flip?: { h: boolean, v: boolean }): Matrix3x3 {
  const safeFlip = flip || { h: false, v: false };
  const R = Matrix3x3.rotate(rotation);
  const F = new Matrix3x3(safeFlip.h ? -1 : 1, 0, 0, safeFlip.v ? -1 : 1, 0, 0);
  return R.multiply(F);
}

/**
 * Whether a layer's own axes diverge from the canvas axes.
 *
 * True when the layer carries a non-zero rotation (normalised to [0,360)) or any
 * mirror flag — e.g. after a canvas Rotate Left/Right, where `transformFrame`
 * bumps `rotation` but leaves `bounding` untouched.
 *
 * THE SINGLE SOURCE OF TRUTH for the "does this need local-axes math?" question.
 * `TransformHandler.needsOrientationPath` and the marker/text resize handlers all
 * defer to this: if they ever disagreed, one side would treat a rect as canvas-
 * local while the other treats it as object-local — a silent coordinate error
 * with no type-level protection (both are branded `LocalRect`).
 */
export function isRotatedPose(layer: Pick<Layer, 'rotation' | 'flip'>): boolean {
  const rot = ((layer.rotation % 360) + 360) % 360;
  return rot !== 0 || !!layer.flip?.h || !!layer.flip?.v;
}

/**
 * Compute the correct (cx, cy) world-space anchor for a fragment layer whose
 * visible content starts at `visibleOffset` within its bounding box.
 *
 * Background:
 *   WorldMatrix = Translate(cx, cy) × Orientation(rotation, flip) × Translate(-bw/2, -bh/2)
 *   When bounding = visibleShape size, the content center in world space becomes:
 *     worldCenter = (cx, cy) + Orientation × (vx, vy)
 *   Solving for (cx, cy):
 *     (cx, cy) = worldCenter − Orientation × (vx, vy)
 *
 * The previous simplified formula (cx = center.x - vx) only works when
 * Orientation is identity (no rotation, no flip). This function handles
 * the general case correctly.
 */
export function computeFragmentCenter(
  worldCenter: { x: number; y: number },
  visibleOffset: { x: number; y: number },
  rotation: number,
  flip: { h: boolean; v: boolean }
): { x: number; y: number } {
  const O = getOrientationMatrix(rotation, flip);
  const rotatedOffset = O.apply(visibleOffset);
  return {
    x: worldCenter.x - rotatedOffset.x,
    y: worldCenter.y - rotatedOffset.y,
  };
}

/**
 * [External] Fuses all geometric elements: center position, viewport shape (visibleShape), rotation, flip, scaling, etc.
 */
export function getLayerWorldMatrix(layer: Layer, override?: LayerPoseOverride): Matrix3x3 {
  const cx = override?.cx ?? layer.cx;
  const cy = override?.cy ?? layer.cy;
  const rotation = override?.rotation ?? layer.rotation;

  return computeWorldMatrix({
    cx,
    cy,
    rotation,
    flip: layer.flip,
    bounding: layer.bounding,
    scale: override?.scale,
    scaleY: override?.scaleY,
    sourceAngle: override?.sourceAngle,
  });
}

/**
 * Derived method: directly get Local Space matrix (top-left reference)
 */
export function getLayerLocalMatrix(layer: Layer, canvasDim: { w: number, h: number }, override?: LayerPoseOverride): Matrix3x3 {
  const w_matrix = getLayerWorldMatrix(layer, override);
  return Matrix3x3.translate(canvasDim.w / 2, canvasDim.h / 2).multiply(w_matrix);
}

/**
 * DecomposedMatrix: Semantic pose parameters after matrix decomposition
 */
export interface DecomposedMatrix {
  rotation: number;
  flip: { h: boolean; v: boolean };
  scaleX: number;
  scaleY: number;
}

/**
 * [Internal] Matrix decomposition: extract rotation, scaling, flip and other parameters from IMatrix3x3
 */
export function decomposeMatrix(M: IMatrix3x3, refRotation: number = 0): DecomposedMatrix {
  const { a, b, c, d } = M;

  // 1. Calculate scaling (Scale)
  // Pythagorean theorem: a^2 + b^2 = scaleX^2; c^2 + d^2 = scaleY^2
  const scaleX = Math.sqrt(a * a + b * b);
  const scaleY = Math.sqrt(c * c + d * d);

  // 2. Determine mirroring (Determinant)
  const det = a * d - b * c;
  const isMirrored = det < 0;

  const getAngleDist = (angleA: number, angleB: number) => {
    const diff = Math.abs(angleA - (angleB % 360 + 360) % 360);
    return Math.min(diff, 360 - diff);
  };

  // 3. Handle non-mirrored case
  if (!isMirrored) {
    let angle = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    angle = ((angle % 360) + 360) % 360;

    const angleA = angle;
    const angleB = (angle + 180) % 360;
    const distA = getAngleDist(angleA, refRotation);
    const distB = getAngleDist(angleB, refRotation);

    if (distA <= distB) {
      return { rotation: angleA, flip: { h: false, v: false }, scaleX, scaleY };
    } else {
      return { rotation: angleB, flip: { h: true, v: true }, scaleX, scaleY };
    }
  }

  // 4. Handle mirrored case (horizontal flip or vertical flip)
  let thetaH = Math.round((Math.atan2(-b, -a) * 180) / Math.PI);
  thetaH = ((thetaH % 360) + 360) % 360;

  let thetaV = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  thetaV = ((thetaV % 360) + 360) % 360;

  const distH = getAngleDist(thetaH, refRotation);
  const distV = getAngleDist(thetaV, refRotation);

  if (distH <= distV) {
    return { rotation: thetaH, flip: { h: true, v: false }, scaleX, scaleY };
  } else {
    return { rotation: thetaV, flip: { h: false, v: true }, scaleX, scaleY };
  }
}

/**
 * Transform a LocalPolygon by applying a D4 symmetry operation (rotation / flip)
 * within a container of size (oldW, oldH).
 *
 * Point transforms (derived from Matrix3x3.transformRect with w=0, h=0):
 *   rotate_r: (px, py) → (oldH - py, px)
 *   rotate_l: (px, py) → (py, oldW - px)
 *   flip_h:   (px, py) → (oldW - px, py)
 *   flip_v:   (px, py) → (px, oldH - py)
 */
export function transformPolygon(
  poly: LocalPolygon,
  container: { w: number; h: number },
  op: GeometryOp
): LocalPolygon {
  const { w: oldW, h: oldH } = container;

  const transformPoint = (px: number, py: number): { x: number; y: number } => {
    switch (op) {
      case 'rotate_r': return { x: oldH - py, y: px };
      case 'rotate_l': return { x: py, y: oldW - px };
      case 'flip_h': return { x: oldW - px, y: py };
      case 'flip_v': return { x: px, y: oldH - py };
      default: return { x: px, y: py };
    }
  };

  const nextRings = poly.rings.map(ring =>
    ring.map(p => asLocalPoint(transformPoint(p.x, p.y)))
  );

  // Orientation record folds with the SAME rigid transform as the vertices
  // (orientation decree — the record must always reflect the polygon's real
  // on-canvas direction, never reset by a canvas transform): rotate adds ±90° in the
  // same clockwise-positive convention as rotatePolygon; a single mirror
  // reverses the rotation direction, so both flips negate the record.
  const orientation = poly.orientationDeg ?? 0;
  const nextOrientation =
    op === 'rotate_r' ? orientation + 90
    : op === 'rotate_l' ? orientation - 90
    : op === 'flip_h' || op === 'flip_v' ? -orientation
    : orientation;

  const nextBounds = asLocalRect(computePolygonBounds(nextRings));
  return asLocalPolygon(nextRings, nextBounds, {
    antiAliased: poly.antiAliased,
    feather: poly.feather,
    orientationDeg: nextOrientation,
  });
}


/**
 * Exact orientation composition for ONE CANVAS TRANSFORM op (the ±90 / flip
 * family). With the
 * orientation contract O = R(rot) × F, the composition O_op × O_layer is
 * closed-form — NO matrix decomposition needed (and decomposeMatrix rounds
 * to whole degrees, which silently quantizes any fractional layer rotation
 * on every canvas-transform round trip: content rotation −2.7° + canvas
 * rotate 90° + reset used
 * to come back as −3°, a visible residual tilt).
 *
 *   rotate ±90: O_op = R(δ) → R(δ)·R(rot)·F = R(rot+δ)·F
 *               ⇒ rotation += δ, flips untouched.
 *   flip axis:  O_op = F  → F·R(rot)·F_layer:
 *               F_layer = ∅ ⇒ R(−rot)·F  (rotation negates, axis toggles on)
 *               F_layer = F ⇒ F·R(rot)·F = R(−rot) (rotation negates, axis
 *               toggles off)
 *               ⇒ rotation negates, the flipped axis toggles.
 */
export function composeD4Orientation(
  rotation: number,
  flip: { h: boolean; v: boolean },
  operation: 'rotate_r' | 'rotate_l' | 'flip_h' | 'flip_v',
): { rotation: number; flip: { h: boolean; v: boolean } } {
  const normalize = (deg: number) => {
    const r = ((deg % 360) + 360) % 360;
    // Keep the [0,360) record canonical; 360 folds to 0.
    return r === 360 ? 0 : r;
  };
  switch (operation) {
    case 'rotate_r':
      return { rotation: normalize(rotation + 90), flip };
    case 'rotate_l':
      return { rotation: normalize(rotation - 90), flip };
    case 'flip_h':
      return { rotation: normalize(-rotation), flip: { ...flip, h: !flip.h } };
    case 'flip_v':
      return { rotation: normalize(-rotation), flip: { ...flip, v: !flip.v } };
  }
}




/**
 * Optional draft-remap hook: pure-geometry operators stay draft-agnostic —
 * the application layer (state/drafts glue) injects this so a viewport
 * transform carries its drafts along in the same record rewrite.
 */
type RemapDrafts = (
  drafts: Record<string, unknown> | undefined,
  canvas: Dimensions,
) => Record<string, unknown> | undefined;

/**
 * Execute artboard-level CANVAS TRANSFORM (rotation/flip): the whole document
 * coordinate system changes — canvas resizes, camera re-bases, the clip box
 * and the selection ride along, every layer pose moves by the D4 linear part,
 * and the orientation record composes the operation EXACTLY (closed form via
 * composeD4Orientation — no whole-degree decomposition rounding, which used
 * to quantize fractional layer rotations on every transport round trip).
 *
 * Frame drafts travel with the pixels through the INJECTED remap hook: the
 * operator itself knows nothing about the draft registry. Keys without a
 * transform hook pass through verbatim — unknown drafts are never corrupted.
 */
export function transformFrame(
  frame: Frame,
  operation: 'rotate_r' | 'rotate_l' | 'flip_h' | 'flip_v',
  remapDrafts?: RemapDrafts,
): Frame {
  let O: Matrix3x3;
  const isRotation = operation.startsWith('rotate');
  const oldW = frame.canvas.w;
  const oldH = frame.canvas.h;

  switch (operation) {
    case 'rotate_r': O = Matrix3x3.rotate90(1); break;
    case 'rotate_l': O = Matrix3x3.rotate90(-1); break;
    case 'flip_h': O = Matrix3x3.flipH(); break;
    case 'flip_v': O = Matrix3x3.flipV(); break;
    default: return frame;
  }

  // Layer-rewrite pass: every layer pose (and birthCenter anchor) moves by
  // the D4 linear part O.
  const nextById: Record<string, typeof frame.layers.byId[string]> = {};
  frame.layers.order.forEach(id => {
    const l = frame.layers.byId[id];
    const { rotation, flip } = composeD4Orientation(l.rotation, l.flip, operation);
    const nextP = O.apply({ x: l.cx, y: l.cy });

    // birthCenter records a world-space anchor; when the coordinate system
    // itself rotates/flips (canvas transform), it must follow the same
    // transformation as cx/cy.
    const nextBirthCenter = l.birthCenter
      ? (() => { const bp = O.apply({ x: l.birthCenter.cx, y: l.birthCenter.cy }); return { cx: bp.x, cy: bp.y }; })()
      : undefined;

    nextById[id] = { ...l, cx: nextP.x, cy: nextP.y, rotation, flip, birthCenter: nextBirthCenter };
  });

  const nextW = isRotation ? oldH : oldW;
  const nextH = isRotation ? oldW : oldH;
  const delta = isRotation ? (operation === 'rotate_r' ? 90 : -90) : 0;

  const nextCamera = { ...frame.camera };
  if (isRotation) {
    nextCamera.x += (oldW - nextW) / 2 * frame.camera.k;
    nextCamera.y += (oldH - nextH) / 2 * frame.camera.k;
  }

  const nextCanvasCropBox = Matrix3x3.transformRect(frame.canvasClipBox.rect, frame.canvas, operation);

  // Transform the frame-level selection entity. Apply the same D4 symmetry
  // operation so the selection stays aligned with pixels after rotation/flip.
  const nextConfinement = frame.confinement
    ? transformPolygon(frame.confinement, frame.canvas, operation)
    : null;

  return {
    ...frame,
    canvas: { w: nextW, h: nextH },
    rotation: (frame.rotation || 0) + delta,
    layers: { byId: nextById, order: frame.layers.order },
    camera: nextCamera,
    confinement: nextConfinement,
    canvasClipBox: { ...frame.canvasClipBox, rect: asLocalRect(nextCanvasCropBox) },
    drafts: remapDrafts?.(frame.drafts, frame.canvas) ?? frame.drafts,
  };
}

/**
 * Pose-override view of the canvas straighten for ONE layer: the pivot map
 * applied to (cx, cy) plus the additive rotation. This is the function the
 * render engine calls per pointermove for the live drag preview; the
 * materialization step rewrites the records through the IDENTICAL
 * expressions the straighten materialization rewrites, so preview pixels ==
 * materialized pixels bitwise, by construction.
 *
 * `pivot` is in top-left canvas coordinates; the pose space (canvas-center
 * origin — getLayerLocalMatrix re-adds the canvas-center offset, and the ±90
 * canvas transform likewise rotates poses about that origin) is entered inline by
 * re-anchoring the pivot: mixing the two spaces shifts the pivot map by
 * exactly half a canvas — "rotate about the center" vs "about the corner".
 */
export function rotatePoseAboutPivot(
  layer: Pick<Layer, 'cx' | 'cy' | 'rotation'>,
  pivot: Point2D,
  canvas: Dimensions,
  thetaDeg: number,
): { cx: number; cy: number; rotation: number } {
  const P = { x: pivot.x - canvas.w / 2, y: pivot.y - canvas.h / 2 };
  const O = Matrix3x3.rotate(thetaDeg);
  const dx = layer.cx - P.x;
  const dy = layer.cy - P.y;
  return {
    cx: P.x + dx * O.a + dy * O.c,
    cy: P.y + dx * O.b + dy * O.d,
    rotation: layer.rotation + thetaDeg,
  };
}

/**
 * LayerMovePose: Pre-computed rotation-aware pose information for layer move operations.
 *
 * Computed once at onStart and reused throughout the drag because rotation/flip
 * do not change during a move operation.
 */
export interface LayerMovePose {
  /** World-space fixed offset between visible content center and (cx, cy) = O × visibleOffset */
  centerOffset: Point2D;
  /** AABB size after rotation (world-space axis-aligned bounding box dimensions) */
  aabbSize: Dimensions;
  /** Original visibleOffset in local space (for reference / computeFragmentCenter compatibility) */
  visibleOffset: Point2D;
}

/**
 * Compute rotation-aware pose information for a layer move operation.
 *
 * This correctly handles arbitrary rotation/flip by projecting the visible rect's
 * corners through the orientation matrix to determine the true world-space AABB size.
 *
 * The returned values are constant for the entire duration of a move operation
 * (since rotation does not change during move), so this should be called once in onStart.
 *
 * For rotation=0, flip=none: centerOffset={0,0} if visibleShape fills bounding,
 * and aabbSize={rect.w, rect.h} — identical to pre-refactoring behavior.
 */
export function computeLayerMovePose(layer: Layer): LayerMovePose {
  const rect = layer.visibleShape?.rect || { x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h };

  // Visible content center relative to bounding center (local space offset)
  const visibleOffset: Point2D = {
    x: rect.x + rect.w / 2 - layer.bounding.w / 2,
    y: rect.y + rect.h / 2 - layer.bounding.h / 2
  };

  // Orientation matrix
  const O = getOrientationMatrix(layer.rotation, layer.flip);

  // Rotated fixed offset (world space): visibleCenter = (cx, cy) + centerOffset
  const centerOffset: Point2D = O.apply(visibleOffset);

  // Rotated AABB size: project 4 corners of the visible rect and take min/max
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  const corners = [
    O.apply({ x: -halfW, y: -halfH }),
    O.apply({ x:  halfW, y: -halfH }),
    O.apply({ x: -halfW, y:  halfH }),
    O.apply({ x:  halfW, y:  halfH }),
  ];
  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  const aabbW = Math.max(...xs) - Math.min(...xs);
  const aabbH = Math.max(...ys) - Math.min(...ys);

  return {
    centerOffset,
    aabbSize: { w: aabbW, h: aabbH },
    visibleOffset
  };
}

// ─── Canvas fit rects (straighten crop presets) ──────────────────────────────

/** Size of the axis-aligned bounding box of a W×H rect rotated by thetaDeg. */
export function circumscribedRectSize(
  w: number, h: number, thetaDeg: number,
): { w: number; h: number } {
  const r = (thetaDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { w: w * c + h * s, h: w * s + h * c };
}

/**
 * Size of the LARGEST axis-aligned rectangle inscribed in a W×H rect rotated
 * by thetaDeg about its center (the straighten crop "fit inside" preset).
 *
 * Closed-form KKT solution. A centered candidate with half-extents (x, y)
 * fits the rotated original iff, for its WORST corners (all four, x/y ≥ 0):
 *   x·cosθ + y·sinθ ≤ W/2      (max |un-rotated lx| over the corner signs)
 *   x·sinθ + y·cosθ ≤ H/2      (max |un-rotated ly|)
 * Maximizing xy:
 *   - both constraints active  →  x = (W·c − H·s)/(2·cos2θ),
 *                                 y = (H·c − W·s)/(2·cos2θ),
 *     admissible only while both numerators stay ≥ 0;
 *   - exactly one active (the Lagrange condition x/y = c/s or s/c) gives the
 *     single-side solutions  x = H/(4s), y = H/(4c)  and  x = W/(4c),
 *     y = W/(4s).
 * The true optimum is the largest-area member of this candidate set; each
 * candidate is re-verified against the exact containment test before it may
 * win, so the operator can never emit a box that pokes out of the rotated
 * original (a UI crop-box PRESET must not lie). At θ = 0 the degenerate
 * answer is the rect itself.
 */
export function inscribedRectSize(
  w: number, h: number, thetaDeg: number,
): { w: number; h: number } {
  // Fold into [0, 90) — the inscribed problem is symmetric under the
  // complementary angle with the dims swapped.
  const t = ((thetaDeg % 90) + 90) % 90;
  const r = (t * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  if (t < 1e-9) return { w, h };

  const fits = (x: number, y: number): boolean =>
    x > 0 && y > 0 && isFinite(x) && isFinite(y)
    && x * c + y * s <= w / 2 + 1e-7
    && x * s + y * c <= h / 2 + 1e-7;

  const candidates: Array<{ x: number; y: number }> = [];
  const d = Math.cos(2 * r);
  if (Math.abs(d) > 1e-9) {
    candidates.push({ x: (w * c - h * s) / (2 * d), y: (h * c - w * s) / (2 * d) });
  }
  candidates.push({ x: h / (4 * s), y: h / (4 * c) });
  candidates.push({ x: w / (4 * c), y: w / (4 * s) });

  let best = { x: 0, y: 0 };
  for (const cand of candidates) {
    if (!fits(cand.x, cand.y)) continue;
    if (cand.x * cand.y > best.x * best.y) best = cand;
  }
  return { w: best.x * 2, h: best.y * 2 };
}
