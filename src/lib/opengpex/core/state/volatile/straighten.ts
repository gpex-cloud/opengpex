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
 * straighten.ts — the live CONTENT TRANSFORM (free-angle straighten) drag
 * protocol. Terminology: the ±90/flip family is the CANVAS TRANSFORM (the
 * whole document coordinate system changes, content rides along); this
 * family keeps the canvas fixed and rotates the content under it.
 *
 * The protocol triangle: the StraightenControl WRITES the transient (angle +
 * pivot per pointermove), the render engine's pose-override seam and the DOM
 * overlays READ it. This module owns the wire contract (the transient key)
 * and the readers both consumer families share — state layer, because the
 * transient store lives here; the geometry math it dispatches to stays in
 * the pure operator layer (downward import only).
 */

import { Matrix3x3 } from '@opengpex/editor/core/geometry/matrix';
import { rotatePoseAboutPivot } from '@opengpex/editor/core/geometry/operators/transform';
import type { Frame, Point2D, Dimensions } from '@opengpex/editor/core/types';

/** Fast-track transient key carrying the live preview — written by the
 * straighten control, cleared by the straighten command. THE single copy of
 * the key (control, engine seam and overlays all import it from here). */
export const STRAIGHTEN_TRANSIENT_KEY = 'straighten';

/** Wire contract of the in-flight content-transform drag transient.
 *
 * Content transform is a committed materialization operation: the angle shown
 * while dragging has NO persistent field anywhere. During the drag it lives
 * only in this transient and reaches the renderer through the
 * `getLayerPoseOverride` seam as a per-layer pivot rotation; on release the
 * angle is materialized into the pose records about the same pivot and this
 * transient is cleared — preview and materialization are two consumers of
 * the same pivot map, so the pixels never move at the hand-over.
 */
export interface StraightenPreviewPayload {
  /** Free rotation angle in degrees (clockwise-positive, y-down convention). */
  thetaDeg: number;
  /** The rotation pivot, TOP-LEFT-origin canvas coordinates (effective clip
   * rect center — see getStraightenPivot for the selection rule). */
  pivot: Point2D;
}

/**
 * Reads the live content-transform drag transient and returns the preview
 * pose for ONE layer, or undefined when no straighten drag is in flight
 * (or the payload is malformed — overlays must never crash on a partial
 * fast-track write). This is the DOM-side twin of the engine's
 * pose-override seam: both sides call rotatePoseAboutPivot with the same
 * payload, so outlines track the preview pixels exactly.
 */
export function straightenPreviewPose(
  transient: Record<string, unknown> | undefined,
  layer: { cx: number; cy: number; rotation: number },
  canvas: Dimensions,
): { cx: number; cy: number; rotation: number } | undefined {
  const t = transient?.[STRAIGHTEN_TRANSIENT_KEY] as Partial<StraightenPreviewPayload> | undefined;
  if (!t || typeof t.thetaDeg !== 'number' || !t.pivot
    || typeof t.pivot.x !== 'number' || typeof t.pivot.y !== 'number') return undefined;
  return rotatePoseAboutPivot(layer, t.pivot, canvas, t.thetaDeg);
}

/**
 * Reads the raw live content-transform drag payload (angle + pivot), or
 * undefined when no straighten drag is in flight (or the payload is
 * malformed). For consumers that need the ANGLE itself — e.g. an overlay
 * feeding the committed selection polygon through the same rotate primitive
 * the materializer uses — rather than a per-point or per-pose map.
 */
export function straightenPreviewRotation(
  transient: Record<string, unknown> | undefined,
): StraightenPreviewPayload | undefined {
  const t = transient?.[STRAIGHTEN_TRANSIENT_KEY] as Partial<StraightenPreviewPayload> | undefined;
  if (!t || typeof t.thetaDeg !== 'number' || !t.pivot
    || typeof t.pivot.x !== 'number' || typeof t.pivot.y !== 'number') return undefined;
  return { thetaDeg: t.thetaDeg, pivot: t.pivot };
}

/**
 * Reads the live content-transform drag transient and returns a map for
 * CANVAS-LOCAL points (top-left-origin space: pen work-path drafts, rubber
 * tips — anything that is not a layer pose), or undefined when no straighten
 * drag is in flight. Same payload contract and validation as
 * straightenPreviewPose.
 */
export function straightenPreviewPointMap(
  transient: Record<string, unknown> | undefined,
): ((p: Point2D) => Point2D) | undefined {
  const t = transient?.[STRAIGHTEN_TRANSIENT_KEY] as Partial<StraightenPreviewPayload> | undefined;
  if (!t || typeof t.thetaDeg !== 'number' || !t.pivot
    || typeof t.pivot.x !== 'number' || typeof t.pivot.y !== 'number') return undefined;
  const O = Matrix3x3.rotate(t.thetaDeg);
  const P = t.pivot;
  return (p: Point2D) => ({
    x: P.x + (p.x - P.x) * O.a + (p.y - P.y) * O.c,
    y: P.y + (p.x - P.x) * O.b + (p.y - P.y) * O.d,
  });
}

/**
 * The pivot a CONTENT TRANSFORM turns about: the center of the effective
 * clip rectangle. This is a PRODUCT RULE, not math — the Re-Canvas box rests
 * at an over-scan default (larger than the canvas, anchored to one corner)
 * even when the user never touched cropping; that resting box is NOT a crop
 * and must not pull the pivot off the canvas center. Only a box contained
 * within the canvas bounds counts as an effective crop ("rotate about the
 * output center" invariant); anything else falls back to the canvas center.
 * (Business policy therefore lives in the straighten domain module, not in
 * the pure operator layer.)
 */
export function getStraightenPivot(frame: Frame): Point2D {
  const rect = frame.canvasClipBox?.rect;
  if (
    rect &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.w <= frame.canvas.w &&
    rect.y + rect.h <= frame.canvas.h
  ) {
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  }
  return { x: frame.canvas.w / 2, y: frame.canvas.h / 2 };
}
