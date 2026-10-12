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
 * roiFrame.ts — Pure per-frame decision for the ROI composite channel.
 *
 * Split out of `WebGpuEngine` so the roi geometry chain — viewport rect →
 * pixel snap → document intersection → density → texel dims → rebuild key →
 * rebuild need — is a plain function testable without a GPU device. The
 * engine consumes the decision and owns the state it is compared against
 * (the resident roi texture and its stamps); nothing here touches a device.
 *
 * ── MODEL ──
 *   • rect: the block-quantized visible rect (`getVisibleRect`, 128px camera
 *     lattice + half-diagonal margin) snapped OUTWARD to integer document
 *     pixels (`snapRectEdgesToPixel` — the texel-phase guarantee) then
 *     clipped to the document. Null when the viewport is fully off-document:
 *     NO rebuild, the stale roi keeps presenting (its quad mapping off-screen
 *     is what clears the swapchain via the present pass loadOp:'clear').
 *   • density: `resolveRoiDensity` — band-quantized camera scale clamped by
 *     the byte budget (floored at 1) and the device edge limit (NOT floored:
 *     a texture wider than maxTextureDimension2D cannot exist; only deep
 *     zoom-outs hit this, where minified LINEAR sampling hides it).
 *   • rebuildKey: `${x},${y},${x+w},${y+h}|b${band}` of the INTEGER rect —
 *     the exact identity of the rendered texture. The block lattice supplies
 *     the pan hysteresis (small pans keep the rect → same key → present
 *     replay); crossing a block edge or a density band changes the key →
 *     exactly one re-composite.
 *   • needsComposite: true when nothing is resident, or the resident roi's
 *     dims/format (a resize or band crossing), rebuild key (a pan), or
 *     content signature (an edit) no longer matches this frame's decision.
 *
 * @module core/engine/pipeline/graph/support/roiFrame
 */

import type { Scene } from '@opengpex/editor/core/engine/pipeline/scene/Scene';
import type { LocalRect } from '@opengpex/editor/core/types';
import { asLocalRect } from '@opengpex/editor/core/types';
import { getVisibleRect } from '@opengpex/editor/core/geometry/operators/camera';
import { getRectIntersection } from '@opengpex/editor/core/geometry/operators/space';
import { snapRectEdgesToPixel } from '@opengpex/editor/core/geometry/operators/snapping';
import { resolveRoiDensity, workingFormatBpp } from './compositeBudget';
import {
  densityCompositeDims,
  type InteractiveDensity,
} from './densityComposite';

/** The engine's resident roi stamps the decision is compared against. */
export interface RoiFrameState {
  /** Whether a roi texture is currently resident. */
  readonly resident: boolean;
  /** Rebuild key the resident roi was rendered at. */
  readonly rectKey: string | null;
  /** Content signature the resident roi was rendered at. */
  readonly signature: string | null;
  /** Texel dims of the resident roi texture. */
  readonly targetW: number;
  readonly targetH: number;
  /** Working format the resident roi was built at. */
  readonly format: GPUTextureFormat | null;
}

/** What the roi channel must render/present this frame. */
export interface RoiFrameDecision {
  /**
   * Document-space rect (frame-local px) the roi texture covers, or null
   * when the viewport is fully off-document (no rebuild; present the stale
   * roi so its off-screen quad mapping clears the swapchain).
   */
  readonly rect: LocalRect | null;
  /** Density the roi renders at (null together with rect). */
  readonly density: InteractiveDensity | null;
  /** Texel dims of the roi target (rect × density). */
  readonly targetW: number;
  readonly targetH: number;
  /** Rebuild key of the decision (empty string when rect is null). */
  readonly rebuildKey: string;
  /** Resident dims/format no longer match (destroy + recreate before rendering). */
  readonly dimsChanged: boolean;
  /** True when the resident roi (if any) must be re-rendered this frame. */
  readonly needsComposite: boolean;
}

/**
 * Decide the roi channel's frame. Pure — the engine feeds its resident stamps
 * via `current` and backfills them from the returned decision after rendering.
 */
export function resolveRoiFrame(input: {
  /** Incoming Scene — only `view.transform` (camera) and `view.target` (viewport) are read. */
  readonly scene: Scene;
  /** Document dims (composite frame). */
  readonly docW: number;
  readonly docH: number;
  /** Camera's physical screen scale (`effectiveScale(view.transform)`). */
  readonly screenScale: number;
  /** Working composite format — selects the bpp term of the budget clamp. */
  readonly workingFormat: 'rgba16float' | 'rgba32float';
  /** Negotiated `GPUDevice.limits.maxTextureDimension2D` — never hard-coded. */
  readonly deviceMaxDim: number;
  /** Policy budget tier (see compositeBudget). */
  readonly budgetBytes: number;
  /** This frame's content signature (see compositeSignature). */
  readonly signature: string;
  /** The engine's resident roi stamps. */
  readonly current: RoiFrameState;
}): RoiFrameDecision {
  const m = input.scene.view.transform;
  const visible = getVisibleRect(
    { w: input.scene.view.target.width, h: input.scene.view.target.height },
    // The consumer feeds the PHYSICAL camera (view.transform includes DPR;
    // view.target is the physical viewport). The operator is unit-agnostic —
    // blocks are 128 camera-output px, the same lattice mechanism the CSS-px
    // ants consumer uses.
    { x: m.tx, y: m.ty, k: input.screenScale },
  );
  if (!visible) {
    return { rect: null, density: null, targetW: 0, targetH: 0, rebuildKey: '', dimsChanged: false, needsComposite: false };
  }

  // Snap OUTWARD to integer document pixels FIRST: the block lattice's
  // fractional edges would otherwise offset the texel lattice against the
  // document pixel grid — rest misalignment + a phase jump on every rebuild.
  // Integer origin × integer band = zero phase, so rebuilds change only
  // sharpness, never block positions.
  const snapped = snapRectEdgesToPixel(visible.rect);
  const rect = getRectIntersection(snapped, asLocalRect({ x: 0, y: 0, w: input.docW, h: input.docH }));
  if (!rect) {
    return { rect: null, density: null, targetW: 0, targetH: 0, rebuildKey: '', dimsChanged: false, needsComposite: false };
  }

  const density = resolveRoiDensity({
    screenScale: input.screenScale,
    roiW: rect.w,
    roiH: rect.h,
    bpp: workingFormatBpp(input.workingFormat),
    deviceMaxDim: input.deviceMaxDim,
    budgetBytes: input.budgetBytes,
  });
  const [targetW, targetH] = densityCompositeDims(rect.w, rect.h, [density.scaleX, density.scaleY]);
  // Rebuild key = the INTEGER roi extent + band (the block lattice underneath
  // supplies the pan hysteresis, and the pixel snap makes the key the exact
  // identity of the rendered texture).
  const rebuildKey = `${rect.x},${rect.y},${rect.x + rect.w},${rect.y + rect.h}|b${density.band}`;
  const dimsChanged =
    input.current.targetW !== targetW ||
    input.current.targetH !== targetH ||
    input.current.format !== input.workingFormat;
  const needsComposite =
    !input.current.resident || dimsChanged ||
    input.current.rectKey !== rebuildKey || input.current.signature !== input.signature;

  return { rect, density, targetW, targetH, rebuildKey, dimsChanged, needsComposite };
}
