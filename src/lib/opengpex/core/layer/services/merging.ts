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
 * Layer merging — the bake executor and the product-type table in one module.
 * Single entry `mergeLayers` (the counterpart of `clipFragment`), consumed by
 * mergeSelected, mergeDown and mergeVisible — the COMPOSITING entries: the
 * user's picture must survive. Restoring a source (Merge Back / Merge
 * Fragments) is a different family and does not go through here.
 *
 * Merging is ALWAYS a bake: the participants are composited as seen into the
 * BOTTOM participant as one physical bitmap (`physicalPixels: true`). The
 * product type comes from `resolveMergedType`; every craft payload is
 * stripped because the pixels now carry that content. Cross-group
 * participation is NOT a refusal: the product anchors to the BOTTOM
 * participant (its group membership wins), so merging across a group edge is
 * explicit intent.
 *
 * Participants are always ordered bottom to top: the composite stacking
 * order and the survivor choice depend on it.
 *
 * The only refusals are two pre-route guards, outside any table: fewer than
 * two participants, and any group participant (groups are containers, not
 * pixel layers — there is no merge semantics for them). Groups never reach
 * this resolver on UI paths (the Layers drawer cannot mark a group, and
 * merge visible filters its visible set); the guard exists for programmatic
 * callers.
 *
 * @module core/layer/services/merging
 */

import { EditorActions, Frame, GeometryService, Layer, LayerService } from '@opengpex/editor/core/types';
import { matchRule, type DecisionRule } from '@opengpex/editor/core/helpers/decision-table';

export type MergeStrategyOp = 'bake' | 'noop';

export interface MergeStrategyAction {
  readonly op: MergeStrategyOp;
  /** Set when the merge is refused (`noop`); the command surfaces it as HUD. */
  readonly hud?: string;
}

/**
 * Resolve the merge strategy for a participant set (ordered bottom to top).
 * Pure: reads only the layer records. Two guards: fewer than two
 * participants, and any group participant. Groups never reach here on UI
 * paths (the Layers drawer cannot mark a group, and merge visible filters
 * its visible set); the guard exists for programmatic callers of
 * `mergeLayers`. Everything else bakes.
 */
export function resolveMergeStrategy(
  participants: readonly Layer[],
): MergeStrategyAction {
  if (participants.length < 2) return { op: 'noop', hud: 'Need at least 2 layers to merge.' };
  if (participants.some(l => l.type === 'group')) {
    return { op: 'noop', hud: 'Cannot merge group layers' };
  }
  return { op: 'bake' };
}

export interface MergeOptions {
  /** Success HUD for the bake. */
  readonly physicalSuccessHud?: string;
  /** Error HUD for a failed bake; defaults to a generic failure. */
  readonly errorHud?: string;
}

export function createMergeOperations(
  geometry: GeometryService,
  layers: LayerService,
  actions: EditorActions,
): { mergeLayers: (frame: Frame, participants: readonly Layer[], options?: MergeOptions) => Promise<MergeStrategyOp> } {
  const deps: MergeDeps = { geometry, layers, actions };

  /**
   * Single entry for the merge commands: guard the participant set, then
   * bake. A refused merge surfaces the HUD message. Returns the outcome.
   */
  async function mergeLayers(
    frame: Frame,
    participants: readonly Layer[],
    options?: MergeOptions,
  ): Promise<MergeStrategyOp> {
    const strategy = resolveMergeStrategy(participants);
    if (strategy.op === 'noop') {
      if (strategy.hud) actions.setInteraction({ hud: { message: strategy.hud, type: 'error' } });
      return 'noop';
    }
    await physicalMerge(deps, frame, participants, options);
    return strategy.op;
  }

  return { mergeLayers };
}

// ─── Executors and shared pure helpers ───────────────────────────────────────

/** Services an executor needs to mutate the frame and surface HUD messages. */
export interface MergeDeps {
  readonly geometry: GeometryService;
  readonly layers: LayerService;
  readonly actions: EditorActions;
}

// ─── Bake product type inference ─────────────────────────────────────────────

/**
 * The bake branch never sees group participants (the guard intercepts them),
 * so this table is total over craft/image/vector mixes.
 */
type MergedTypeContext = { readonly types: readonly Layer['type'][] };
type MergedProductType = 'paint' | 'image';

const CRAFT_TYPES: readonly Layer['type'][] = ['paint', 'text', 'color'];
const MERGED_TYPE_FIELDS: readonly (keyof MergedTypeContext)[] = ['types'];

export const MERGED_TYPE_RULES: readonly DecisionRule<MergedTypeContext, MergedProductType>[] = [
  // Subset relation MUST be a function predicate: the shared runtime's array
  // pattern means "admits any listed member", not "subset of the set".
  {
    id: 'R1',
    condition: { types: (t) => t.every(x => CRAFT_TYPES.includes(x)) },
    action: 'paint',
  },
  { id: 'R2', condition: { types: '*' }, action: 'image' },
];

/**
 * Product type of a bake merge, from the participants' deduped type set.
 * Pure craft mixes merge into `paint`; anything involving image or vector
 * degrades to `image`.
 */
export function resolveMergedType(types: readonly Layer['type'][]): MergedProductType {
  const deduped = [...new Set(types)].sort();
  return matchRule(MERGED_TYPE_RULES, { types: deduped }, MERGED_TYPE_FIELDS, 'merged-type').action;
}

/** Craft payload keys that must not ride forward on a baked product. */
const CRAFT_PAYLOAD_KEYS = ['textData', 'markerData', 'strokeData', 'strokes', 'penData', 'penStyle'] as const;

/** Spreadable patch clearing every craft payload (explicit undefined removes). */
export function craftPayloadStrip(): Record<string, undefined> {
  return Object.fromEntries(CRAFT_PAYLOAD_KEYS.map(k => [k, undefined]));
}

// ─── Executors ───────────────────────────────────────────────────────────────

/**
 * The bake executor: composite the participants as seen into the BOTTOM
 * participant as one physical bitmap.
 *
 * Phase numbering below follows execution order:
 *   Phase 2  bake (composite → register → warm, services/baking.ts)
 *   Phase 3  cut-link metadata handling (survivor lineage strip)
 *   Phase 4  commit — type/payload strip, remove participants
 *   Phase 5  demote outside children of participants to plain layers
 *
 * Phase ordering is load-bearing: removeLayers with `'ignore-link'` never touches
 * the sources' masks, and the survivor's own mask state was just reset by
 * the bake write — any mask rewrite from the stale command snapshot would
 * clobber those fresh values.
 */
export async function physicalMerge(
  deps: MergeDeps,
  frame: Frame,
  participants: readonly Layer[],
  options?: MergeOptions,
): Promise<void> {
  const { layers, actions } = deps;
  if (participants.length < 2) return;

  const target = participants[0];
  const items = participants.slice(1);

  try {
    // Shared bake primitive (services/baking.ts): composite → register → warm.
    const bake = await layers.bakeToAsset(frame, [...participants]);

    // The survivor is no longer "the piece cut from S" — it is a composite.
    // Strip its cut-link pointers in the same transaction (resetWithBounds
    // keeps existing metadata keys, so this only removes the two). The hole
    // its source still holds keeps its assocLayerId → survivor id as a
    // dead-end id: Merge Back / Merge Fragments require the target layer to
    // point back, so it restores nothing and is never counted.
    const stripLineage = (metadata: Layer['metadata']): Layer['metadata'] => {
      const { sourceLayerId: _src, assocMaskId: _mask, ...rest } = metadata ?? {};
      return rest;
    };
    layers.updateLayer(frame.id, (tx) => {
      tx.edit(target.id)
        .setAsset({ assetId: bake.assetId, url: bake.url })
        .resetWithBounds(bake.bounds.w, bake.bounds.h, bake.bounds.x + bake.bounds.w / 2, bake.bounds.y + bake.bounds.h / 2)
        // physicalPixels must ride along: the patch replaces the metadata the
        // resetWithBounds above just declared (stripLineage reads the stale
        // pre-bake snapshot).
        .patch({ metadata: { ...stripLineage(target.metadata), physicalPixels: true } });
    });

    // The composite burnt every participant's grade chain and payload into
    // the merged pixels; the survivor must not carry any of it forward.
    actions.updateLayer(frame.id, target.id, {
      type: resolveMergedType(participants.map(l => l.type)),
      ...craftPayloadStrip(),
      bitmapMasks: [],
      adjustMasks: undefined,
    } as Partial<Layer>);

    // Must batch-remove all non-target participants in a single call: the
    // command snapshot is stale throughout execution, so per-layer removals
    // would each read the same stale vectorMasks in the cut-link cleanup
    // hook and the last write would win, leaving residual hole masks on
    // sources.
    // Touch no mask ('ignore-link'): the survivor's masks were just reset by the
    // bake write above, and a cut-link cleanup computed from this stale
    // snapshot would write the survivor's OLD holes back onto the baked
    // layer (the survivor is often the source of the removed fragments).
    // Holes on other sources keep dead-end ids, which nothing resolves.
    layers.removeLayers(frame.id, items.map(item => item.id), { cutLinks: 'ignore-link' });

    // End the cut relationships the bake consumed: layers OUTSIDE the set
    // whose source is a participant (the survivor, whose holes are gone with
    // the reset, or a deleted member, whose holes are gone with it) would be
    // orphans pointing at baked pixels — deleting them later via their Merge
    // Back would only delete the layer while the hole can never come back
    // (lost content). Demote them to plain layers. Their pixels are untouched
    // by the bake, so the picture is unchanged.
    const participantIds = new Set(participants.map(l => l.id));
    for (const id of frame.layers.order) {
      if (participantIds.has(id)) continue;
      // Read fresh: the survivor's metadata was just rewritten above.
      const layer = actions.fast?.latestLayer?.(frame.id, id) ?? frame.layers.byId[id];
      const sourceId = layer?.metadata?.sourceLayerId as string | undefined;
      if (!sourceId || !participantIds.has(sourceId)) continue;
      actions.updateLayer(frame.id, id, { metadata: stripLineage(layer.metadata) });
    }

    layers.activate(frame.id, target.id);

    if (options?.physicalSuccessHud) {
      actions.setInteraction({ hud: { message: options.physicalSuccessHud, type: 'success' } });
    }
  } catch (err) {
    console.error('[PhysicalMerge] Failed:', err);
    actions.setInteraction({ hud: { message: options?.errorHud ?? 'Merge failed.', type: 'error' } });
  }
}
