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
 * translators/index.ts — the SceneTranslator: the SINGLE business → engine
 * translation seam that turns a `Layer`'s content payload into its
 * engine-neutral {@link LayerSource} (the pixel-production declaration the
 * renderer consumes).
 *
 * THREE ARMS, ONE PRINCIPLE — the arms are classified by WHERE THE PIXELS
 * LIVE, and a layer resolves through exactly one of them:
 *   • `vector`  — the payload is a GEOMETRIC description (strokes / pen /
 *                 marker / text): rendered analytically on the GPU, zero
 *                 bytes. Dispatched through the contributor REGISTRY
 *                 (`vector.ts`) so plugin tools plug in without touching the
 *                 engine core.
 *   • `solid`   — the payload is a COLOR description (fillColor): the
 *                 declarative `{kind:'solid'}` source, working-LINEAR uniform
 *                 colour, zero bytes (`solid.ts`).
 *   • `raster`  — the payload IS pixels (a pool asset handle): the
 *                 `{kind:'raster'}` source whose whole content is the
 *                 per-pixel-form COLOR IDENTITY adjudication (`raster.ts`).
 *
 * The assembler (`SceneAssembler`) owns the seams and side effects — the
 * source-resolution probes, the upload plan, masks/grades. It calls
 * {@link translateLayerSource} first; `undefined` means "no declarative
 * arm claimed this layer" and the assembler then runs its raster probes and
 * calls {@link buildRasterSource} with the resolved inputs. This split keeps
 * the translators PURE (no cache, no I/O, no frame state) while the
 * probe-then-translate ordering stays inside the assembler's documented
 * stage reduction.
 *
 * @module core/engine/pipeline/scene/translators
 */

import type { Layer, WorkingColorSpace, GamutId } from '@opengpex/editor/core/types';
import type { LayerSource } from '../Scene';
import type { HighDepthSource } from '../../../sources/HighDepthCache';
import { buildRasterSource } from './raster';
import { layerToVectorSource } from './vector';
import { layerToSolidSource } from './solid';

// Re-exported: the plugin contributor contract travels with the seam.
export {
  layerToVectorSource,
  registerVectorSourceContributor,
  resetVectorSourceContributorsForTest,
  strokeToVectorSource,
  textToVectorSource,
  strokeSourceFingerprint,
} from './vector';
export type {
  VectorSourceContributor,
  VectorSourceContext,
  VectorSourceOptions,
} from './vector';
export { layerToSolidSource } from './solid';
export { buildRasterSource, proxyBitmapGamut } from './raster';
export type { RasterPoolRecord, RasterSourceInputs } from './raster';
export type { LayerSource } from '../Scene';
// EngineContribution lives in its OWN ownership-neutral module — the umbrella
// aggregates the per-slot contracts and must not be hosted inside any single
// slot's implementation file.
export type { EngineContribution } from '../engineContribution';

/**
 * Resolve a layer's DECLARATIVE source (the vector or solid arm), or
 * `undefined` when the layer's pixels are a pool-asset handle (the raster
 * arm — the assembler resolves its probes and calls `buildRasterSource`).
 *
 * Priority is fixed: geometric description (vector) beats colour description
 * (solid) beats pixel handle (raster). The payloads are disjoint in practice,
 * but the ordering keeps the boundary explicit.
 *
 * Pure: same layer + same working space ⇒ identical output.
 */
export function translateLayerSource(
  layer: Layer,
  workingSpace: WorkingColorSpace,
  dims: { readonly width: number; readonly height: number },
): Extract<LayerSource, { kind: 'vector' | 'solid' }> | undefined {
  // `layerToVectorSource` is typed against the whole LayerSource union
  // (historical — its strategies only ever produce `kind:'vector'`); the
  // check narrows the dispatch contract to the two declarative arms.
  const source = layerToVectorSource(layer, workingSpace, dims) ?? layerToSolidSource(layer, workingSpace);
  return source && source.kind !== 'raster' ? source : undefined;
}

// ─── The full three-arm resolver (the assembler's ONE source call) ──────────

/**
 * The injection seams the raster arm needs to resolve its pixel handle.
 * All optional so engine-less test assembly simply never resolves a bitmap
 * (those layers carry no upload and render via their declarative fallbacks).
 */
export interface TranslateLayerDeps {
  readonly workingSpace: WorkingColorSpace;
  readonly dims: { readonly width: number; readonly height: number };
  /** Resolve a layer's stored `src` into a fetchable URL (AssetService.resolve). */
  readonly resolveSrc?: (assetId: string, src: string) => string;
  /** 8-bit read seam (decoded-bitmap cache; a miss kicks the one-shot decode). */
  readonly getBitmapSource?: (src: string) => ImageBitmap | undefined;
  /** Per-layer precision seam (16/32-bit naked pixels, or undefined for 8-bit). */
  readonly getHighDepthSource?: (assetId: string) => HighDepthSource | undefined;
  /** Pool-record read seam (the per-asset ColorIdentity + dprScale authority). */
  readonly getAssetRecord?: (assetId: string) =>
    | (RasterArmRecord)
    | undefined;
  /** The RAW style preset toggle resolved once per frame by the assembler. */
  readonly rawStyleOn: boolean;
}
/** Structural view of the pool record the raster arm reads. */
type RasterArmRecord = {
  readonly trc?: 'srgb-trc' | 'linear';
  readonly gamut?: GamutId;
  readonly rawWhiteDomain?: number;
  readonly dprScale?: number;
};

/**
 * What the raster arm's probes produced — the assembler's upload plan
 * consumes these (the declarative arms carry `raster: undefined` and upload
 * nothing). MINIMAL by construction: every field here is absent from the
 * built source. `assetId`/the TRANSFER-time gamut tag are NOT carried —
 * both live on the source (source.assetId; source.gamut === the transfer
 * fold on the 8-bit bitmap path where the tag is consumed — see raster.ts's
 * SYNC note) and the assembler reads them off the narrowed source.
 */
export interface RasterPayload {
  /** The decoded 8-bit bitmap (bitmap-upload payload); undefined = not resolved. */
  readonly bitmap: ImageBitmap | undefined;
  /** The 16/32-bit naked buffer (raw-upload payload); undefined = 8-bit asset. */
  readonly highDepth: HighDepthSource | undefined;
  /** The pool record's physical/logical factor — a LayerNode field, not a LayerSource field. */
  readonly dprScale: number;
}

// (No wrapper interface: translateLayer returns the pair inline —
// `{ source, raster }` reads exactly as it is used at the assembler's
// push site.)

/**
 * Translate ONE layer into its LayerSource — the assembler's single source
 * call (the push site reads `translated.source`). Arms:
 *   1. vector/solid (declarative, pure) — probes are SHORT-CIRCUITED: there
 *      is no asset behind the declaration, and a legacy persisted id
 *      resolving to nothing is the normal path, never a decode attempt;
 *   2. raster (pixel handle) — the seams resolve src → bitmap probe →
 *      high-depth probe → pool record, then `buildRasterSource` adjudicates
 *      the color identity.
 *
 * The raster arm's probes carry the buildContent HIDDEN-I/O contract (a
 * cache miss kicks a one-shot decode + notifies subscribers → next-tick
 * rebuild; see SceneAssembler.buildContent). This call must sit at the
 * assembler's stage-2 position: its probe results feed the upload plan that
 * follows, and calling it twice would repeat the probes.
 */
export function translateLayer(layer: Layer, deps: TranslateLayerDeps): {
  readonly source: LayerSource;
  /** Present only for the raster arm (pixel handle); declarative arms upload nothing. */
  readonly raster: RasterPayload | undefined;
} {
  const declarative = translateLayerSource(layer, deps.workingSpace, deps.dims);
  if (declarative) {
    return { source: declarative, raster: undefined };
  }

  // ── Raster arm: the payload IS pixels (a pool asset handle). ──
  const assetId = layer.assetId || layer.id;
  const currentSrc = layer.src
    ? deps.resolveSrc
      ? deps.resolveSrc(layer.assetId, layer.src)
      : layer.src
    : null;
  const bitmap: ImageBitmap | undefined =
    currentSrc && deps.getBitmapSource ? deps.getBitmapSource(currentSrc) ?? undefined : undefined;
  const record = deps.getAssetRecord?.(assetId);
  // A DPR-aware rasterized texture (e.g. a resampled layer bitmap sized
  // `bounding × dpr`) tags its asset with `dprScale = dpr`; crop is LOGICAL px,
  // so resolveLayerGeometry needs this factor to map crop→UV. Bitmap/fragment
  // assets have it undefined → 1 (crop already in source pixels).
  const dprScale = record?.dprScale ?? 1;
  const highDepth = deps.getHighDepthSource ? deps.getHighDepthSource(assetId) : undefined;
  const source = buildRasterSource({
    assetId,
    poolRecord: record,
    hasHighDepthEntry: highDepth !== undefined,
    rawStyleOn: deps.rawStyleOn,
  });
  return { source, raster: { bitmap, highDepth, dprScale } };
}
