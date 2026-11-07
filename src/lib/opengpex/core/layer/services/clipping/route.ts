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
 * Clip routing: one decision table drives Copy (Cmd+C), Layer via Copy
 * (Cmd+J), Cut (Cmd+X) and Layer via Cut (Shift+Cmd+J) for every layer type.
 *
 * Routing inputs are computed once per command (layer type, whether a
 * selection exists, how the selection overlaps the layer, which command), the
 * table picks an operation and a source-layer action, and one executor per
 * operation builds the product. Commands only decide WHERE the product goes
 * (clipboard or a new layer above the source) and apply the source mask.
 *
 * Operations:
 * - `whole`: duplicate the entire layer, original type and payload intact.
 * - `logical`: crop by geometry — the fragment shares the source asset and
 *   narrows its visible shape. Only exact when the fragment's whole edge is
 *   the selection contour: a hard selection on a raster-backed layer whose
 *   holes fold into hard geometry.
 * - `rasterize`: bake the selected part into a new image layer — text and
 *   vector layers (their geometry cannot be cropped without changing it), and
 *   every cut whose edge is soft or not geometric (feathered selection,
 *   bitmap-mask source, source holes with feather). The baked fragment is a
 *   snapshot; the source hole carries the cut's feather.
 * - `noop`: refuse with a HUD message.
 *
 * Source actions (applied only by the cut commands):
 * - `fullMask`: hide the whole source behind an inverted full-bounds mask,
 *   with no cut link — the product went to the clipboard, so there is no
 *   fragment in this frame to link to.
 * - `fullHoleLink`: the same full mask, linked to the new layer so deleting
 *   or merging that layer back restores the source.
 * - `holeLink`: a hole shaped like the taken region, linked to the fragment.
 *
 * @module core/layer/services/clip-routing
 */

import {
  Frame, Layer, VectorMask, GeometryService, asLocalShape,
} from '@opengpex/editor/core/types';
import { matchRule, type DecisionRule } from '@opengpex/editor/core/helpers/decision-table';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { classifyRegionOverlap, type RegionOverlap } from '@opengpex/editor/core/geometry/poly-clip';
import { shapeToPoint2D } from '@opengpex/editor/core/geometry/operators/point2d';
import { LayerFactory } from '../../factory';
import type { createFragmentOperations } from './strategies';
import type { createBakeOperations } from '../baking';

export type ClipMode = 'copy' | 'copyToLayer' | 'cut' | 'cutToLayer';
export type ClipOp = 'whole' | 'logical' | 'rasterize' | 'noop';
export type ClipSourceAction = 'none' | 'fullMask' | 'fullHoleLink' | 'holeLink';

export interface ClipRouteContext {
  readonly layerType: Layer['type'];
  readonly hasSelection: boolean;
  /** Undefined when there is no selection. */
  readonly overlap: RegionOverlap | undefined;
  readonly mode: ClipMode;
  /**
   * A partial clip of a raster-backed layer must bake its product instead of
   * cropping it logically. Always true for rasterize-type layers (their
   * geometry cannot be cropped); for raster-backed layers it marks feathered
   * selections, bitmap-mask sources and sources whose holes do not fold into
   * hard geometry. Routing guarantees every partial cut picks exactly one of
   * the two rows per mode, so no context is ever ambiguous.
   */
  readonly needsPhysical: boolean;
}

export interface ClipRouteAction {
  readonly op: ClipOp;
  readonly sourceAction: ClipSourceAction;
  readonly hud?: string;
}

const ROUTE_FIELDS: readonly (keyof ClipRouteContext)[] = ['layerType', 'hasSelection', 'overlap', 'mode', 'needsPhysical'];

const COPY_MODES: readonly ClipMode[] = ['copy', 'copyToLayer'];
const CUT_MODES: readonly ClipMode[] = ['cut', 'cutToLayer'];
/** Raster-backed content: narrowing the bounds crops it without altering it. */
const LOGICAL_TYPES: readonly Layer['type'][] = ['image', 'paint', 'color'];
/** Geometry derived from the bounds (text layout, marker fit, stroke space). */
const RASTERIZE_TYPES: readonly Layer['type'][] = ['text', 'vector'];

/** First match wins; row order is priority. */
export const CLIP_ROUTE_RULES: readonly DecisionRule<ClipRouteContext, ClipRouteAction>[] = [
  { id: 'R1', condition: { layerType: '*', hasSelection: false, overlap: '*', mode: COPY_MODES, needsPhysical: '*' }, action: { op: 'whole', sourceAction: 'none' } },
  { id: 'R2', condition: { layerType: '*', hasSelection: false, overlap: '*', mode: 'cut', needsPhysical: '*' }, action: { op: 'whole', sourceAction: 'fullMask' } },
  { id: 'R3', condition: { layerType: '*', hasSelection: false, overlap: '*', mode: 'cutToLayer', needsPhysical: '*' }, action: { op: 'noop', sourceAction: 'none', hud: 'No active selection' } },
  { id: 'R4', condition: { layerType: '*', hasSelection: true, overlap: 'full', mode: COPY_MODES, needsPhysical: '*' }, action: { op: 'whole', sourceAction: 'none' } },
  { id: 'R5', condition: { layerType: '*', hasSelection: true, overlap: 'full', mode: 'cut', needsPhysical: '*' }, action: { op: 'whole', sourceAction: 'fullMask' } },
  { id: 'R6', condition: { layerType: '*', hasSelection: true, overlap: 'full', mode: 'cutToLayer', needsPhysical: '*' }, action: { op: 'whole', sourceAction: 'fullHoleLink' } },
  { id: 'R7', condition: { layerType: '*', hasSelection: true, overlap: 'none', mode: '*', needsPhysical: '*' }, action: { op: 'noop', sourceAction: 'none', hud: 'Selection does not overlap the layer' } },
  { id: 'R8', condition: { layerType: LOGICAL_TYPES, hasSelection: true, overlap: 'partial', mode: COPY_MODES, needsPhysical: false }, action: { op: 'logical', sourceAction: 'none' } },
  { id: 'R9', condition: { layerType: LOGICAL_TYPES, hasSelection: true, overlap: 'partial', mode: CUT_MODES, needsPhysical: false }, action: { op: 'logical', sourceAction: 'holeLink' } },
  { id: 'R10', condition: { layerType: '*', hasSelection: true, overlap: 'partial', mode: COPY_MODES, needsPhysical: true }, action: { op: 'rasterize', sourceAction: 'none' } },
  { id: 'R11', condition: { layerType: '*', hasSelection: true, overlap: 'partial', mode: CUT_MODES, needsPhysical: true }, action: { op: 'rasterize', sourceAction: 'holeLink' } },
  { id: 'R00', condition: { layerType: '*', hasSelection: '*', overlap: '*', mode: '*', needsPhysical: '*' }, action: { op: 'noop', sourceAction: 'none' } },
];

export function routeClip(ctx: ClipRouteContext): ClipRouteAction {
  return matchRule(CLIP_ROUTE_RULES, ctx, ROUTE_FIELDS, 'clip').action;
}

export interface ClipFragmentResult {
  readonly op: ClipOp;
  /** The product: written to the clipboard or inserted above the source. */
  readonly newLayer?: Layer;
  /** PNG for external applications; produced only for clipboard modes. */
  readonly clipboardUrl?: string;
  /** Mask to append to the source layer's vectorMasks (cut modes only). */
  readonly sourceMask?: VectorMask;
  readonly hud?: string;
}

const CLIPBOARD_MODES: readonly ClipMode[] = ['copy', 'cut'];

/** Layers whose `src` is real pixel content rather than the shared placeholder. */
const RASTER_SOURCE_TYPES: readonly Layer['type'][] = ['image', 'paint'];

/**
 * Every executor carries a lock-free product: a new layer must never inherit
 * the source's lock, or a locked fragment could not be moved.
 */
const unlocked = (layer: Layer): Layer => ({ ...layer, locked: false });

type Executor = (
  frame: Frame, layer: Layer, mode: ClipMode, action: ClipRouteAction, feather: number,
) => Promise<ClipFragmentResult>;

export function createClipRoutingOperations(
  geometry: GeometryService,
  fragmentOps: ReturnType<typeof createFragmentOperations>,
  bakeOps: ReturnType<typeof createBakeOperations>,
) {
  /**
   * Layer-local comparison: the selection is mapped into the layer's own space
   * (a rigid transform, so feather distances are preserved) and compared with
   * the layer's visible shape, defaulting to its full bounds.
   */
  function resolveOverlap(frame: Frame, layer: Layer, feather: number): RegionOverlap | undefined {
    const box = getClipBox(frame);
    if (!box) return undefined;
    const selection = geometry.polygon.frameLocalToLayerLocal(box, frame, layer).rings;
    const region = shapeToPoint2D(
      layer.visibleShape ?? asLocalShape({ x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h }),
    );
    return classifyRegionOverlap(selection, region, feather);
  }

  /**
   * Full-bounds inverted rect: hides the whole layer. The rect extends 1 px
   * beyond the bounding on every side because a rotated layer's resampled
   * content bleeds about that far past its axis-aligned bounds — a mask cut
   * exactly at the bounds would leave a partial-coverage halo of the old
   * content. The mask itself is invisible, so the overshoot is free.
   */
  function fullBoundsMask(layer: Layer, link?: { maskId: string; assocLayerId: string }): VectorMask {
    return LayerFactory.getNewVectorMask(
      asLocalShape({ x: -1, y: -1, w: layer.bounding.w + 2, h: layer.bounding.h + 2 }, 'rect'),
      { inverted: true, ...(link ?? {}) },
    );
  }

  const executeWhole: Executor = async (frame, layer, mode, action) => {
    const { id: _id, hostId: _h, role: _r, locked: _l, interactive: _i, ...layerData } = layer;
    let metadata = layerData.metadata;
    if (metadata?.assocMaskId) {
      // A duplicate must not claim the source's own cut relationship.
      const { assocMaskId: _a, ...rest } = metadata;
      metadata = rest;
    }
    const intoFrame = !CLIPBOARD_MODES.includes(mode);
    let newLayer = unlocked(LayerFactory.getNewLayer({
      ...layerData,
      metadata,
      // Clipboard products keep the source name; paste adds its own suffix.
      name: intoFrame
        ? LayerFactory.getNewLayerName(frame.layers.order.map(lid => frame.layers.byId[lid]), `${layer.name} Copy`)
        : layer.name,
      vectorMasks: LayerFactory.cleanInheritedMasks(layerData.vectorMasks),
      bitmapMasks: LayerFactory.cleanInheritedMasks(layerData.bitmapMasks),
    }));

    let sourceMask: VectorMask | undefined;
    if (action.sourceAction === 'fullMask') {
      sourceMask = fullBoundsMask(layer);
    } else if (action.sourceAction === 'fullHoleLink') {
      const maskId = `mask-hole-${newLayer.id}`;
      sourceMask = fullBoundsMask(layer, { maskId, assocLayerId: newLayer.id });
      newLayer = { ...newLayer, metadata: { ...newLayer.metadata, sourceLayerId: layer.id, assocMaskId: maskId } };
    }

    let clipboardUrl: string | undefined;
    if (!intoFrame) {
      // Non-raster layers hold only a 1x1 placeholder in `src`; external
      // applications need the rendered layer instead.
      clipboardUrl = RASTER_SOURCE_TYPES.includes(layer.type)
        ? layer.src
        : (await bakeOps.bakeToAsset(frame, [layer])).url;
    }
    return { op: 'whole', newLayer, sourceMask, clipboardUrl };
  };

  const executeLogical: Executor = async (frame, layer, mode, action) => {
    const result = await fragmentOps.clipToLogicalLayer(frame, layer, {
      mode: action.sourceAction === 'holeLink' ? 'cut' : 'copy',
      // The clipboard severs cut links: a clipboard Cut's hole names a
      // product that never enters the document, so it is written unlinked.
      linkHole: !CLIPBOARD_MODES.includes(mode),
    });
    if (!result) return { op: 'noop', hud: 'Area is empty' };

    let clipboardUrl: string | undefined;
    if (CLIPBOARD_MODES.includes(mode)) {
      const physical = await fragmentOps.clipToPhysicalLayer(frame, layer);
      if (!physical) return { op: 'noop', hud: 'Area is empty' };
      clipboardUrl = physical.url;
    }
    return { op: 'logical', newLayer: unlocked(result.newLayer), sourceMask: result.holeMask, clipboardUrl };
  };

  const executeRasterize: Executor = async (frame, layer, mode, action, feather) => {
    const physical = await fragmentOps.clipToPhysicalLayer(frame, layer, { feather });
    if (!physical) return { op: 'noop', hud: 'Area is empty' };

    // The product is an image layer; the source keeps its original type.
    // Drop the source's own cut link pointer — the product starts unlinked
    // and gets its own pointers below when the mode cuts.
    const { assocMaskId: _a, ...productMetadata } = physical.newLayer.metadata ?? {};
    const newLayer = unlocked({ ...physical.newLayer, metadata: { ...productMetadata } });

    // Cut modes punch a hole shaped like the selection and link it to the
    // fragment, so Merge Back / Merge Fragments restores the source. The
    // hole carries the cut's feather, so fragment and hole are complementary.
    let sourceMask: VectorMask | undefined;
    if (action.sourceAction === 'holeLink') {
      const maskId = `mask-hole-${newLayer.id}`;
      const linked = !CLIPBOARD_MODES.includes(mode);
      sourceMask = LayerFactory.getNewVectorMask(physical.holeShape, {
        maskId,
        ...(linked ? { assocLayerId: newLayer.id } : {}),
        inverted: true,
        feather,
      });
      newLayer.metadata = {
        ...newLayer.metadata,
        sourceLayerId: layer.id,
        ...(linked ? { assocMaskId: maskId } : {}),
      };
    }

    let clipboardUrl: string | undefined;
    if (CLIPBOARD_MODES.includes(mode)) clipboardUrl = physical.url;
    return { op: 'rasterize', newLayer, sourceMask, clipboardUrl };
  };

  const executeNoop: Executor = async (_frame, _layer, _mode, action) => ({ op: 'noop', hud: action.hud });

  const EXECUTORS: Record<ClipOp, Executor> = {
    whole: executeWhole,
    logical: executeLogical,
    rasterize: executeRasterize,
    noop: executeNoop,
  };

  /**
   * Single entry for the four clip commands. Returns the product and the
   * source mask; the caller writes the product to its destination and appends
   * the mask to the source layer.
   */
  async function clipFragment(
    frame: Frame,
    layer: Layer,
    options: { mode: ClipMode },
  ): Promise<ClipFragmentResult> {
    // Feather source decree (selection-feather upgrade): the selection
    // entity OWNS the feather — it is resolved here, from the frame, and no
    // caller may pass it in (the service signature carries no feather).
    const feather = frame.confinement?.feather ?? 0;
    const overlap = resolveOverlap(frame, layer, feather);
    const action = routeClip({
      layerType: layer.type,
      hasSelection: overlap !== undefined,
      overlap,
      mode: options.mode,
      // A rasterize-type layer always bakes; a raster-backed layer bakes only
      // when its fragment's edge would not be exact geometry.
      needsPhysical: RASTERIZE_TYPES.includes(layer.type)
        || fragmentOps.shouldRoutePhysical(frame, layer, feather),
    });

    return EXECUTORS[action.op](frame, layer, options.mode, action, feather);
  }

  return { clipFragment };
}
