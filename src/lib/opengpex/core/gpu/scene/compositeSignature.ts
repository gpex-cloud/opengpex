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
 * compositeSignature.ts — Content signature for the composite cache (缺陷 5 §5 阶段 2).
 *
 * WHY A VALUE-BASED STRING (not reference / version-counter)
 * ----------------------------------------------------------
 * `SceneAssembler` builds a BRAND-NEW `Scene` object every frame even when
 * nothing changed, so `scene === lastScene` is ALWAYS false — reference
 * equality cannot drive the cache. And a hand-maintained global revision counter
 * would spread "what counts as dirty" across every edit entry-point in the app
 * (the exact 缺陷-5-class trap: one forgotten bump → a stale frame). Instead we
 * derive a value-based signature from the declarative Scene in ONE place: the
 * signature IS the single source of truth for "would re-compositing change the
 * pixels?". Missing a field here is a visible, reviewable, testable omission.
 *
 * WHAT IS IN THE SIGNATURE (everything that affects the COMPOSITED TEXTURE):
 *   • document dimensions (frame.width/height) — texture size + NDC mapping;
 *   • working format — the composite texture's pixel format;
 *   • per layer, in order: id, transform, width/height, crop, opacity, blendMode,
 *     clip, mask (all fields), source (kind + assetId), adjustments, filters;
 *   • per raster layer: the asset EPOCH — bumps whenever the resident texture is
 *     actually re-transferred (erase/filter/redecode). This is the defence
 *     against "same assetId, new pixels" (R2 miss-detection).
 *
 * WHAT IS DELIBERATELY EXCLUDED (present-time concerns — do NOT re-composite):
 *   • `scene.view` (camera transform + swapchain target) — the whole point of
 *     缺陷 5: pan/zoom only replay the view pass.
 *   • `scene.display.channelMask` — applied in the VIEW pass, not the compose
 *     passes (RenderGraph composites with 'rgb'), so channel isolation toggling
 *     only re-presents. ⚠️ COUPLING: this exclusion is correct ONLY while
 *     compositing is channel-agnostic. If channelMask ever moves into a compose
 *     pass, it MUST be added here.
 *   • `scene.display.colorSpace` / `hdr` — swapchain sink concerns, no effect on
 *     the linear working-space composite (color management is Phase 3, applied
 *     at present/export sinks). Same coupling caveat applies if that changes.
 *
 * @module core/gpu/scene/compositeSignature
 */

import type { Scene, LayerNode, MaskDesc } from './Scene';

export interface CompositeSignatureOptions {
  /**
   * Returns a monotonically-increasing epoch for a resident asset that bumps on
   * every genuine re-transfer (not on deduped no-op uploads). Undefined/unknown
   * assets return 0. This is what makes "same assetId, edited pixels" dirty.
   */
  readonly getAssetEpoch: (assetId: string) => number;
  /** Working (composite) texture format — a format change requires re-compositing. */
  readonly workingFormat: string;
}

function maskSig(mask: MaskDesc | undefined): string {
  if (!mask) return '-';
  if (mask.kind === 'bitmap') {
    return `bitmap:${mask.maskId}:${mask.inverted ? 1 : 0}:${mask.hard ? 1 : 0}`;
  }
  // vector: rings are polygon rings in world space (+ inverted/feather/hard).
  return `vector:${JSON.stringify(mask.rings)}:${mask.inverted ? 1 : 0}:${mask.feather}:${mask.hard ? 1 : 0}`;
}

function layerSig(layer: LayerNode, opts: CompositeSignatureOptions): string {
  const t = layer.transform;
  const tSig = `${t.a},${t.b},${t.c},${t.d},${t.tx},${t.ty}`;
  const crop = layer.crop ? `${layer.crop.x},${layer.crop.y},${layer.crop.w},${layer.crop.h}` : '-';
  // §fix/20260911: dprScale changes the crop→UV mapping (physical vs logical
  // texture space), so it affects the composited pixels and must be part of the
  // signature. Defaults to 1 (bitmap/fragment) so existing sigs are unchanged.
  const dpr = layer.dprScale ?? 1;

  let srcSig: string;
  if (layer.source.kind === 'raster') {
    // Include the epoch so an in-place pixel edit (same assetId) is detected.
    srcSig = `raster:${layer.source.assetId}:${opts.getAssetEpoch(layer.source.assetId)}`;
  } else {
    srcSig = `stroke:${layer.source.strokeId}`;
  }

  // adjustments/filters are small declarative arrays (Phase 3); JSON is
  // deterministic for these plain-number descriptors and future-proofs the sig.
  const adjSig = layer.adjustments && layer.adjustments.length ? JSON.stringify(layer.adjustments) : '-';
  const fltSig = layer.filters && layer.filters.length ? JSON.stringify(layer.filters) : '-';

  return [
    `id:${layer.id}`,
    `t:${tSig}`,
    `wh:${layer.width ?? ''},${layer.height ?? ''}`,
    `crop:${crop}`,
    `dpr:${dpr}`,
    `op:${layer.opacity}`,
    `bm:${layer.blendMode}`,
    `clip:${layer.clip ? 1 : 0}`,
    `mask:${maskSig(layer.mask)}`,
    `src:${srcSig}`,
    `adj:${adjSig}`,
    `flt:${fltSig}`,
  ].join('|');
}

/**
 * Compute the composite-cache signature for a Scene. Two Scenes with equal
 * signatures produce a pixel-identical composited texture, so the cached
 * composite can be reused and only the (cheap, camera-dependent) view pass
 * replayed. See module doc for the field inclusion/exclusion rationale.
 */
export function computeCompositeSignature(scene: Scene, opts: CompositeSignatureOptions): string {
  const head = `f:${scene.frame.width}x${scene.frame.height}|wf:${opts.workingFormat}|n:${scene.layers.length}`;
  if (scene.layers.length === 0) return head;
  const body = scene.layers.map((l) => layerSig(l, opts)).join('||');
  return `${head}||${body}`;
}
