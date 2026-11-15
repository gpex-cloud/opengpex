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
 * translators/raster.ts — the raster arm of the SceneTranslator family: the
 * pixel-handle → LayerSource translation for every BYTE-CARRYING layer
 * (image/paint and their logical fragments).
 *
 * Unlike the vector/solid arms there is no domain-vocabulary mapping here —
 * the payload IS the pixels (a pool asset handle). The translation is the
 * COLOR IDENTITY ADJUDICATION: which transfer characteristic and source gamut
 * the sampling shader must apply for THIS layer's pixels, judged per-asset
 * and per-PIXEL-FORM. The inputs are the assembler's already-resolved seam
 * results (pool record + high-depth entry presence), so this function stays
 * PURE — the assembler owns the probes, this file owns the rules.
 *
 * @module core/engine/pipeline/scene/translators/raster
 */

import type { GamutId } from '@opengpex/editor/core/types';
import type { LayerSource } from '../Scene';

/**
 * The gamut an asset's 8-bit display bitmap is ACTUALLY encoded in. Browser
 * canvases can only encode sRGB or Display P3, so every decoder writes its
 * 8-bit proxy as sRGB for sRGB assets and as Display P3 for everything wider
 * (Adobe RGB, ProPhoto, BT.2020 masters fold to P3 — the widest
 * canvas-representable gamut). The asset's own gamut describes its HIGH-DEPTH
 * master; tagging the bitmap with it would read P3 bytes as e.g. ProPhoto and
 * massively oversaturate the frame shown before the master is resident.
 */
export function proxyBitmapGamut(assetGamut: GamutId | undefined): GamutId {
  if (!assetGamut || assetGamut === 'srgb') return 'srgb';
  return 'display-p3';
}

/** The pool-record color fields the raster identity adjudication reads. */
export interface RasterPoolRecord {
  readonly trc?: 'srgb-trc' | 'linear';
  readonly gamut?: GamutId;
  readonly rawWhiteDomain?: number;
}

export interface RasterSourceInputs {
  /** The source content hash — the resident-texture key (shared by fragments). */
  readonly assetId: string;
  /**
   * The resolved pool record (StoredAsset's ColorIdentity view — the single
   * per-asset color truth). Undefined = unregistered asset / blank host;
   * every field then falls to its untagged-raster default.
   */
  readonly poolRecord?: RasterPoolRecord;
  /**
   * Did the assembler's high-depth probe resolve an entry for this asset?
   * The MASTER (16/32-bit) vs PROXY (8-bit / cold) pixel-form gate — see the
   * per-pixel-form rules below.
   */
  readonly hasHighDepthEntry: boolean;
  /**
   * The RAW style preset toggle resolved ONCE by the assembler from
   * `frame.rawStyle` (undefined/ON = on). Passed in — frame state is the
   * assembler's input, never re-derived here.
   */
  readonly rawStyleOn: boolean;
}

/**
 * Translate a pixel-handle layer into its `{kind:'raster'}` source. See the
 * module doc: this is the raster arm's whole logic — the per-pixel-form
 * color-identity adjudication documented inline below.
 */
export function buildRasterSource(inputs: RasterSourceInputs): Extract<LayerSource, { kind: 'raster' }> {
  const { assetId, poolRecord, hasHighDepthEntry, rawStyleOn } = inputs;
  return {
    kind: 'raster',
    // Must match the resident-texture key used in the assembler's upload plan:
    // the source content hash, so fragments sharing an origin
    // resolve to the same GPUTexture in RenderGraph.
    assetId,
    // The asset's colour DOMAIN, judged per-asset from the decoder's
    // reported interpretation. 8-bit bitmap assets have no high-depth entry, so
    // this stays undefined ⇒ 'srgb-trc' (correct: browser decoders always emit
    // sRGB-encoded pixels). NEVER derived from `frame.trc` — see LayerSource.trc.
    // Identity reads come from the POOL RECORD (`ColorIdentity` — the
    // single authority); the high-depth cache entry carries NO identity
    // (bytes-only, 2026-11-15).
    //
    // ⚠️ PER-PIXEL-FORM rule, trc axis: a resident MASTER samples its own
    // record trc; the 8-bit PROXY (entry absent — cold window or an
    // 8-bit asset) is browser-decoded sRGB bytes, so its trc is ALWAYS
    // 'srgb-trc' — never the master's 'linear'. Leaking the master trc
    // onto proxy bytes skips the TRC decode and reads bright (2026-11-15
    // session finding: existing frames' proxies rendered bright until
    // re-import).
    trc: hasHighDepthEntry ? (poolRecord?.trc ?? 'srgb-trc') : 'srgb-trc',
    // Forwarding terminus: the per-asset source gamut the GPU sampling
    // shader converts to the working space (ProPhoto RGB). High-depth sources
    // carry their own decoded gamut; 8-bit bitmap sources (no high-depth
    // entry) read the asset's OWN colorIdentity.gamut (StoredAsset is the
    // sole owner of per-asset color truth, not the frame),
    // matching the identity upload tag above, so gamut_id resolves to
    // srgb(1)/p3(0) and the shader aligns srgb→P3 (p3 is a no-op).
    // Falls back to `'srgb'` only if the asset entry can't be resolved — the
    // frame carries no colour space to fall back to, and sRGB is
    // the universal meaning of an untagged raster.
    // SYNC ⚠️ (8-bit): this RENDER-time tag must equal the TRANSFER-time
    // `UploadSource.gamut` the assembler stamps on the bitmap upload — both
    // go through `proxyBitmapGamut`. They are two independent channels
    // (upload identity vs. shader gamut_to_working); diverging them
    // double-converts or fails to align.
    gamut: hasHighDepthEntry
      ? (poolRecord?.gamut ?? 'srgb')
      // PER-PIXEL-FORM identity (the DNG proxy-cast lesson): a resident
      // master samples its SOURCE gamut verbatim from the record; an
      // 8-bit/cold proxy derives its canvas-representable fold (P3).
      : proxyBitmapGamut(poolRecord?.gamut),
    // Forwarding terminus: the per-asset raw white domain. Its PRESENCE is
    // the render intent — only scene-linear sources (camera RAW) carry a
    // high-depth entry with a domain; 8-bit bitmaps have no high-depth
    // entry ⇒ undefined ⇒ SDR passthrough. Carried forward from the
    // asset's color identity, NEVER re-sniffed here.
    rawWhiteDomain: poolRecord?.rawWhiteDomain,
    // The RAW style preset toggle (resolved by the assembler once per frame).
    // Filled only on scene-linear sources — display-referred layers stay
    // undefined and the resolver's domain-presence gate keeps the style
    // structurally unreachable.
    rawStyleOn: poolRecord?.rawWhiteDomain !== undefined ? rawStyleOn : undefined,
  };
}
