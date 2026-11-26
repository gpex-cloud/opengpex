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
 * The layer-effect chain domain — the single vocabulary and the chain
 * mutation primitives for `Layer.effects` (the structural sibling of the
 * adjustment-mask chain in `core/layer/amask.ts`).
 *
 * Every writer of the chain (the effects drawer, the layers-drawer family
 * row, future preset applications) speaks THIS shape: pure functions that
 * take the owning layer and return a `Partial<Layer>` patch for the existing
 * `updateLayer` channel — no direct store writes, so every caller gets the
 * undo/checkpoint semantics of that channel for free.
 *
 * Order contract:
 * - The array order is the WITHIN-CATEGORY render order. Cross-category, the
 *   render order is physically fixed (shadow beneath, stroke above, content
 *   on top) and is materialized by {@link sortEffectInstancesForRender}; no
 *   mutation here ever relies on global array position for semantics.
 * - Per category at least ONE instance always exists ONCE THE DRAWER HAS
 *   TOUCHED that category: entering a category's panel lazily lands its
 *   floor instance via {@link ensureEffectCategoryInstance}; the drawer
 *   toggles an instance's `enabled` instead of deleting it, and {@link
 *   removeEffectInstance} refuses to empty a category ("no stroke" = a
 *   disabled stroke instance, so drawer tabs never vanish).
 * - `shape` / `feather` / `origin` are reserved seams (coverage scoping and
 *   preset provenance); no function here writes them in the first release.
 *
 * @module core/layer/effects
 */

import type {
  EffectCategory,
  EffectInstance,
  Layer,
  ShadowParams,
  StrokeParams,
} from '@opengpex/editor/core/types';
import { fromHex } from '@opengpex/editor/core/engine/color';

// ─── Shared vocabulary (display labels) ───────────────────────────────────────

/** Product label per `EffectCategory` (the PS Layer Style names). Owned here —
 * the SINGLE vocabulary seat — so display vocabularies live beside the data
 * model (the adjustment-mask precedent). Cross-plugin command invocation does
 * NOT go through this module: per the plugin facade spec it uses the
 * producing plugin's `XxxAPI` object (LayerEffectsDrawer/protocols). */
export const EFFECT_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  stroke: 'Stroke',
  shadow: 'Shadow',
};

// ─── Defaults ─────────────────────────────────────────────────────────────────

/** First-release stroke defaults: black, 3px outside — usable result on open (the "one-shot success" contract). */
export function defaultStrokeParams(): StrokeParams {
  return { color: fromHex('#000000'), widthPx: 3, position: 'outside' };
}

/**
 * First-release shadow defaults: black, 45° light (shadow cast down-right),
 * 8px distance, 8px blur, 60% opacity. The 45° down-right direction with
 * distance 8 resolves to offset (8·cos45°, 8·sin45°) — kept at full float
 * precision; the UI displays rounded values.
 */
export function defaultShadowParams(): ShadowParams {
  const distance = 8;
  const diagonal = distance / Math.SQRT2;
  return {
    color: fromHex('#000000'),
    offsetX: diagonal,
    offsetY: diagonal,
    blurRadius: 8,
    opacity: 0.6,
  };
}

/** Category-specific default parameters (used by append + enable-create paths). */
export function defaultParamsFor(category: EffectCategory): StrokeParams | ShadowParams {
  return category === 'stroke' ? defaultStrokeParams() : defaultShadowParams();
}

/**
 * Fresh effect-instance id — time-prefixed base36 + random suffix, the same
 * collision discipline as layer/frame/adjust-mask ids (one "+" click may
 * create instances within the same millisecond).
 */
export function newEffectInstanceId(): string {
  return `effect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Create one detached chain instance for `category` with default parameters. */
export function createEffectInstance(
  category: EffectCategory,
  opts: { params?: StrokeParams | ShadowParams; id?: string; enabled?: boolean } = {},
): EffectInstance {
  return {
    id: opts.id ?? newEffectInstanceId(),
    category,
    enabled: opts.enabled ?? true,
    params: opts.params ?? defaultParamsFor(category),
  };
}

// ─── Chain queries ────────────────────────────────────────────────────────────

/** The layer's effect chain (empty array for the absent/no-effects state). */
export function getEffectChain(layer: Layer): EffectInstance[] {
  return layer.effects ?? [];
}

/** Find one instance by id (null when absent). */
export function findEffectInstance(layer: Layer, id: string): EffectInstance | null {
  return getEffectChain(layer).find((e) => e.id === id) ?? null;
}

/**
 * 1-based ordinal of one instance WITHIN its category, counting every
 * instance (enabled or not) in chain array order — the SINGLE numbering
 * authority behind the per-instance display names ("Stroke", "Stroke 2", …).
 * Every surface that labels an effect instance (drawer rail, drawer header
 * dropdown, layers-list family rows) must derive its ordinal HERE, never
 * from a filtered or render-sorted sub-list: an enabled-only or
 * cross-category count shifts the numbers and two surfaces name the same
 * instance differently.
 */
export function effectInstanceOrdinal(chain: readonly EffectInstance[], instanceId: string): number {
  const instance = chain.find((i) => i.id === instanceId);
  if (!instance) return 1;
  return chain.filter((i) => i.category === instance.category).findIndex((i) => i.id === instanceId) + 1;
}

/** Display name for one instance: the category label plus its within-category ordinal ("Stroke 2"). */
export function effectInstanceLabel(chain: readonly EffectInstance[], instanceId: string, categoryLabels: Readonly<Record<string, string>>): string {
  const instance = chain.find((i) => i.id === instanceId);
  const base = instance ? (categoryLabels[instance.category] ?? instance.category) : "";
  return effectInstanceOrdinal(chain, instanceId) === 1 ? base : `${base} ${effectInstanceOrdinal(chain, instanceId)}`;
}

/** Count of instances (enabled or not) for one category — the removal floor is 1. */
export function countEffectInstances(layer: Layer, category: EffectCategory): number {
  return getEffectChain(layer).filter((e) => e.category === category).length;
}

/** True when `id` is the last remaining instance of its category (removal must be refused). */
export function isCategoryFloorInstance(layer: Layer, id: string): boolean {
  const instance = findEffectInstance(layer, id);
  if (!instance) return false;
  return countEffectInstances(layer, instance.category) <= 1;
}

/**
 * Render evaluation order: category precedence first (shadow rank 0 beneath,
 * stroke rank 1 above), then the chain array order within each category. Pure
 * and stable — the prepass (prepareEffectSources) and any future raster
 * fallback MUST composite through this ordering so tab order and pixels agree.
 */
export const EFFECT_RENDER_RANK: Readonly<Record<EffectCategory, number>> = {
  shadow: 0,
  stroke: 1,
};

export function sortEffectInstancesForRender(chain: EffectInstance[]): EffectInstance[] {
  return chain
    .map((instance, index) => ({ instance, index }))
    .sort(
      (a, b) =>
        EFFECT_RENDER_RANK[a.instance.category] - EFFECT_RENDER_RANK[b.instance.category] ||
        a.index - b.index,
    )
    .map((entry) => entry.instance);
}

// ─── Chain mutations (pure → Partial<Layer> patches) ─────────────────────────

/**
 * Append a new instance of `category` to the chain, optionally right after
 * `afterId` (the drawer's "+" inserts below the current tab so the new tab
 * appears directly beneath it). Returns the patch carrying the new chain;
 * `patch.effects` is always defined (at least the appended instance).
 */
export function appendEffectInstance(
  layer: Layer,
  category: EffectCategory,
  opts: {
    afterId?: string;
    params?: StrokeParams | ShadowParams;
    /**
     * Caller-supplied id (the drawer generates one so it can activate the new
     * tab immediately — the patch return value alone cannot carry the id).
     * Omitted → a fresh generated id, the historical behaviour.
     */
    id?: string;
    /**
     * New instances arrive DISABLED (default): "+" adds a parametric shell the
     * user turns on deliberately — an off-by-default effect can never surprise
     * by re-painting pixels the moment it lands. The ONE exception is the
     * virtual-floor eye create, which IS an explicit on-request and passes
     * `enabled: true` (PS checkbox semantics: the click itself is the on).
     */
    enabled?: boolean;
  } = {},
): Partial<Layer> {
  const chain = getEffectChain(layer);
  const instance = createEffectInstance(category, { params: opts.params, id: opts.id, enabled: opts.enabled ?? false });
  if (opts.afterId) {
    const at = chain.findIndex((e) => e.id === opts.afterId);
    if (at >= 0) {
      const next = [...chain];
      next.splice(at + 1, 0, instance);
      return { effects: next };
    }
  }
  return { effects: [...chain, instance] };
}

/**
 * Lazily materialize a category's floor instance: when the category has NO
 * instance yet, append one DISABLED instance with default parameters (the
 * resident floor); when it already has any instance, return `null` — the
 * patch is a no-op and must not be executed.
 *
 * This is the drawer's entry write: merely OPENING a category's panel lands
 * its floor instance, so the drawer's tab/panel/trash model never has to
 * reason about a truly empty category — only about enabled vs disabled.
 * Idempotent by construction; the floor starts disabled (the eye turns it
 * on), and the drawer's explicit "+" is the only path that creates further
 * enabled instances.
 */
export function ensureEffectCategoryInstance(
  layer: Layer,
  category: EffectCategory,
  opts: {
    /** Caller-supplied id (the drawer generates one so it can activate the
     * newly materialized tab immediately — see appendEffectInstance). */
    id?: string;
  } = {},
): Partial<Layer> | null {
  if (countEffectInstances(layer, category) > 0) return null;
  const chain = getEffectChain(layer);
  return {
    effects: [...chain, createEffectInstance(category, { enabled: false, id: opts.id })],
  };
}

/**
 * Remove one instance by id. Returns the patch, or `null` when the removal is
 * refused: unknown id, or the instance is its category's floor (the last
 * remaining one — deletion must not empty a category).
 */
export function removeEffectInstance(layer: Layer, id: string): Partial<Layer> | null {
  if (isCategoryFloorInstance(layer, id)) return null;
  const chain = getEffectChain(layer);
  const at = chain.findIndex((e) => e.id === id);
  if (at < 0) return null;
  const next = chain.filter((e) => e.id !== id);
  return { effects: next.length ? next : undefined };
}

/**
 * Replace one instance's parameters wholesale (the drawer's committed edits).
 * Returns `null` when the id is unknown; identity (id/category/enabled) is
 * untouched — use {@link setEffectInstanceEnabled} for the toggle.
 */
export function updateEffectParams(
  layer: Layer,
  id: string,
  params: StrokeParams | ShadowParams,
): Partial<Layer> | null {
  const chain = getEffectChain(layer);
  const at = chain.findIndex((e) => e.id === id);
  if (at < 0) return null;
  const next = [...chain];
  next[at] = { ...next[at], params };
  return { effects: next };
}

/**
 * Toggle one instance's enabled flag (the drawer tab eye / layers-drawer
 * member-row eye). Returns `null` when the id is unknown. The floor rule does
 * NOT apply here: disabling is always allowed — "no effect" is expressed as
 * every instance disabled, never as an empty category.
 */
export function setEffectInstanceEnabled(
  layer: Layer,
  id: string,
  enabled: boolean,
): Partial<Layer> | null {
  const chain = getEffectChain(layer);
  const at = chain.findIndex((e) => e.id === id);
  if (at < 0) return null;
  const next = [...chain];
  next[at] = { ...next[at], enabled };
  return { effects: next };
}
