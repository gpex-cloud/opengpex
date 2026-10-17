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
 * sourceIntent.ts — Single decision point for "what out-of-box rendering intent
 * must the shader apply to this layer's source pixels?"
 *
 * Third sibling of `sourceDomain.ts` / `sourceGamut.ts`. Exactly as those
 * centralise the `LAYER_FLAG_SOURCE_LINEAR` bit and the GAMUT_ID nibble so
 * `CompositePass` and `BlendPass` can never drift, this centralises the
 * RENDER_INTENT nibble packed into the same `flags` word (bits 8..9). One image
 * would otherwise render correct on `source-over` and wrong the moment the user
 * picked `multiply` — the classic split-path symptom.
 *
 * THE INTENT SIGNAL IS `rawWhiteDomain` PRESENCE (2026-10-15): the former
 * `RenderIntent` string tag ('sdr' | 'filmic') was deleted — after the DNG-LUT
 * retirement it had exactly one non-default value, set by exactly the same
 * decode that produces the white domain, so the tag was redundant bookkeeping.
 * Now: the domain is present ⟺ apply the filmic knee (with that domain);
 * absent ⟺ SDR passthrough. One field, one writer (the libraw decode), no
 * second axis to carry forward.
 *
 * The shader contract stays the RENDER_INTENT nibble (0 = SDR passthrough, 1 =
 * generic Filmic S-curve, `LAYER_RENDER_INTENT_SHIFT`) + the `filmic_white`
 * uniform; both are DERIVED at the pass call sites from this module's single
 * resolver result (present ⇒ nibble 1 + the domain value; absent/overridden ⇒
 * nibble 0 + the default domain, which the shader never reads when intent is 0).
 *
 * @module core/gpu/graph/support/sourceIntent
 */

import type { LayerNode } from '../../scene/Scene';

/**
 * Resolve the layer's filmic knee WHITE DOMAIN — the anchored input the knee
 * maps to display white (per-file, decode-sampled; see `filmic.ts`) — or
 * undefined when the filmic intent must NOT apply. One resolver answers both
 * halves: the caller derives the RENDER_INTENT nibble from the presence
 * (`undefined ⇒ 0`) and packs the value itself, so intent and domain can never
 * disagree between the `AdjustPrePass` bake (which OWNS the tone-map) and the
 * composite/blend passes.
 *
 * Returns undefined (SDR passthrough, no tone-map) when:
 *   1. `pipelineOverride` — the pixels come from a pipeline transient (an
 *      `AdjustPrePass` bake and/or `FilterPass` output). ⚠️ CONSTRAINT A: that
 *      transient has ALREADY been tone-mapped once during the bake; applying the
 *      curve again on re-entry into `CompositePass` would crush shadows to black
 *      and blow contrast. The override MUST win, mirroring `isSourceLinear` /
 *      `resolveSourceGamutId` override precedence exactly.
 *   2. the source is not a raster asset — strokes/vectors are display-referred.
 *   3. the asset carries no `rawWhiteDomain` — every non-RAW source (JPEG/PNG/
 *      text/…) has a baked look already and must pass through untouched.
 *
 * Otherwise returns the domain value (scene-linear RAW: the filmic knee, with
 * the asset's own domain as its white point).
 */
export function resolveSourceRawWhiteDomain(
  layer: LayerNode,
  pipelineOverride?: boolean,
): number | undefined {
  if (pipelineOverride) return undefined;
  if (layer.source.kind !== 'raster') return undefined;
  return layer.source.rawWhiteDomain;
}

/**
 * Pack the RENDER_INTENT flags nibble (bits 8..9) for a layer's source:
 *   0 = SDR passthrough, 1 = Filmic knee, 2 = Filmic knee + the RAW style
 * preset colour step. Same arbitration as {@link resolveSourceRawWhiteDomain}
 * (transient override wins, raster-only, domain presence required); the style
 * value additionally requires the per-document `rawStyleOn` toggle that
 * SceneAssembler fills on scene-linear sources — a RAW layer with the preset
 * switched OFF packs 1 (knee only), never a half-applied state.
 */
export function resolveSourceRawIntentNibble(
  layer: LayerNode,
  pipelineOverride?: boolean,
): number {
  if (resolveSourceRawWhiteDomain(layer, pipelineOverride) === undefined) return 0;
  if (layer.source.kind === 'raster' && layer.source.rawStyleOn) return 2;
  return 1;
}
