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
 * - ON/OFF semantics (20261127 ruling, final shape): a DISABLED instance is
 *   a legitimate chain resident — it carries the user's edited parameters
 *   while the effect is off (the drawer renders it as the OFF tab; the
 *   renderer skips it). Nothing here auto-materializes instances on UI
 *   entry (the retired lazy-floor behavior — opening a panel must never
 *   write the layer or spend an Undo step); instances exist only after an
 *   explicit user act (eye enable / "+" / a parameter edit on a tab whose
 *   category has no instance yet). "No stroke" is an ABSENT stroke.
 * - `shape` / `feather` / `origin` are reserved seams (coverage scoping and
 *   preset provenance); no function here writes them in the first release.
 *
 * @module core/layer/effects
 */

import type {
  ColorOverlayParams,
  EffectCategory,
  EffectInstance,
  GradientOverlayParams,
  InnerGlowParams,
  InnerShadowParams,
  Layer,
  OuterGlowParams,
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
  colorOverlay: 'Color Overlay',
  outerGlow: 'Outer Glow',
  gradientOverlay: 'Grad Overlay',
  innerGlow: 'Inner Glow',
  innerShadow: 'Inner Shadow',
};

// ─── Parameter specs (the config seat — see arch/26_effect_param_specs.md) ────

/**
 * One NUMERIC parameter's presentation + constraint spec. The single source
 * of truth for the drawer's slider rows: label (PS Layer Style dialog
 * vernacular — NOT the internal field name), range, step, precision, unit
 * and accessibility copy. Color / blend / dial / tabs / preset controls are
 * deliberately NOT spec'd (their layouts are structural, not parametric).
 *
 * ⚠️ blurRadius caps are PER FAMILY by design: shadow's separable Gaussian
 * kernel runs σ = 2×blur and saturates at a 60px radius, so its UI caps at
 * 20; the glow / inner-shadow families clamp at 50 in the scene translator
 * (effects.ts clampShadowScalar). Do NOT "unify" these caps without
 * re-verifying each family's kernel.
 */
export interface EffectNumericParamSpec {
  /** Params field key (the FastParams object property this row drives). */
  readonly key: string;
  /** UI label — the PS dialog word ("Size", "Spread", "Opacity", …). */
  readonly label: string;
  readonly ariaLabel: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly precision: number;
  /** Display unit suffix after the slider's numeric field (e.g. "px", "%"). */
  readonly unit?: string;
}

/** Numeric slider specs per category, in the panel's display order. */
export const EFFECT_PARAM_SPECS: Readonly<Record<EffectCategory, readonly EffectNumericParamSpec[]>> = {
  stroke: [
    { key: 'widthPx', label: 'Size', ariaLabel: 'Stroke size', min: 1, max: 250, step: 1, precision: 0, unit: 'px' },
  ],
  shadow: [
    { key: 'blurRadius', label: 'Size', ariaLabel: 'Shadow size', min: 0, max: 20, step: 1, precision: 0, unit: 'px' },
    { key: 'spreadPx', label: 'Spread', ariaLabel: 'Shadow spread', min: 0, max: 50, step: 1, precision: 0, unit: 'px' },
    { key: 'opacity', label: 'Opacity', ariaLabel: 'Shadow opacity', min: 0, max: 1, step: 0.01, precision: 2 },
  ],
  outerGlow: [
    { key: 'blurRadius', label: 'Size', ariaLabel: 'Outer glow size', min: 0, max: 50, step: 1, precision: 0, unit: 'px' },
    { key: 'spreadPx', label: 'Spread', ariaLabel: 'Outer glow spread', min: 0, max: 50, step: 1, precision: 0, unit: 'px' },
    { key: 'strength', label: 'Opacity', ariaLabel: 'Outer glow opacity', min: 0, max: 1, step: 0.01, precision: 2 },
  ],
  gradientOverlay: [
    { key: 'angleDeg', label: 'Angle', ariaLabel: 'Gradient angle', min: 0, max: 360, step: 1, precision: 0, unit: '°' },
    { key: 'scale', label: 'Scale', ariaLabel: 'Gradient scale', min: 1, max: 200, step: 1, precision: 0, unit: '%' },
    { key: 'opacity', label: 'Opacity', ariaLabel: 'Gradient opacity', min: 0, max: 1, step: 0.01, precision: 2 },
  ],
  colorOverlay: [
    { key: 'opacity', label: 'Opacity', ariaLabel: 'Color overlay opacity', min: 0, max: 1, step: 0.01, precision: 2 },
  ],
  innerGlow: [
    { key: 'blurRadius', label: 'Size', ariaLabel: 'Inner glow size', min: 0, max: 50, step: 1, precision: 0, unit: 'px' },
    { key: 'spreadPx', label: 'Spread', ariaLabel: 'Inner glow spread', min: 0, max: 50, step: 1, precision: 0, unit: 'px' },
    { key: 'strength', label: 'Opacity', ariaLabel: 'Inner glow opacity', min: 0, max: 1, step: 0.01, precision: 2 },
  ],
  innerShadow: [
    { key: 'blurRadius', label: 'Size', ariaLabel: 'Inner shadow size', min: 0, max: 50, step: 1, precision: 0, unit: 'px' },
    { key: 'spreadPx', label: 'Spread', ariaLabel: 'Inner shadow spread', min: 0, max: 50, step: 1, precision: 0, unit: 'px' },
    { key: 'strength', label: 'Opacity', ariaLabel: 'Inner shadow opacity', min: 0, max: 1, step: 0.01, precision: 2 },
  ],
};

/** The numeric specs of one category, keyed by params field. */
export function effectParamSpecs(category: EffectCategory): Readonly<Record<string, EffectNumericParamSpec>> {
  return Object.fromEntries(EFFECT_PARAM_SPECS[category].map((s) => [s.key, s]));
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

/** First-release stroke defaults: black, 3px outside — usable result on open (the "one-shot success" contract). */
export function defaultStrokeParams(): StrokeParams {
  return {
    color: fromHex('#000000'),
    widthPx: 3,
    position: 'outside',
    // Factory blend = Normal ('source-over') — the reference product's Stroke
    // dialog factory state (the ring flattens into the layer source).
    // Documents written before the field existed read the same value through
    // the scene translator's fallback, so old and new documents agree.
    blendMode: 'source-over',
  };
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
    // PS factory Spread = 0. The field is optional on the type (documents
    // written before Spread existed omit it — the translator reads ?? 0);
    // new defaults write it explicitly so the spec-table guard (every spec
    // key present on defaults) holds.
    spreadPx: 0,
    opacity: 0.6,
    // Factory blend = Multiply — the reference product's Drop Shadow dialog
    // factory state. Documents written before the field existed still read
    // as source-over in the scene translator (zero visual change for old
    // documents); only newly created instances start at Multiply.
    blendMode: 'multiply',
  };
}

/**
 * First-release color-overlay defaults: red at Multiply, full opacity — the
 * Photoshop Color Overlay dialog's own factory state (the same "one-shot
 * success" contract as the stroke/shadow defaults).
 */
export function defaultColorOverlayParams(): ColorOverlayParams {
  return { color: fromHex('#ff0000'), blendMode: 'multiply', opacity: 1 };
}

/**
 * First-release outer-glow defaults: the reference product's Outer Glow
 * dialog factory state — a pale-yellow glow (the Screen-style brightening is
 * approximated with the bright colour itself), 5px blur (the factory "size"),
 * no spread, 50% strength (the factory opacity). The same "one-shot success"
 * contract as the stroke/shadow/colorOverlay defaults.
 */
export function defaultOuterGlowParams(): OuterGlowParams {
  return {
    color: fromHex('#ffffbe'),
    blurRadius: 5,
    spreadPx: 0,
    strength: 0.5,
    // Factory blend = Screen — the reference product's Outer Glow dialog
    // factory state (brightening against the backdrop). Documents written before the
    // field existed still read as source-over in the scene translator; only
    // newly created instances start at Screen.
    blendMode: 'screen',
  };
}

/**
 * First-release gradient-overlay defaults: the reference product's Gradient
 * Overlay dialog factory state — a black→white linear ramp rising
 * bottom→top (angle 90), full scale, full opacity, Normal blend (the
 * factory blend mode, distinct from Color Overlay's Multiply). The same
 * "one-shot success" contract as the other category defaults.
 */
export function defaultGradientOverlayParams(): GradientOverlayParams {
  return {
    start: fromHex('#000000'),
    end: fromHex('#ffffff'),
    style: 'linear',
    angleDeg: 90,
    scale: 100,
    opacity: 1,
    blendMode: 'source-over',
  };
}

/**
 * Built-in two-stop gradient presets feeding the panel's swatch chips — a
 * FROZEN table (the ImageInfoDrawer export-preset precedent: static data
 * only, no user-defined presets in v1). A preset click fills start/end +
 * style in one shot; the other parameters stay as the user left them.
 * User-facing English names; the hex pairs are curated display-viewport
 * colours (the translator resolves them to working-LINEAR like any
 * ColorValue).
 */
export interface GradientPreset {
  /** Stable id (test/guard anchor, doubles as the React key). */
  readonly id: string;
  /** User-facing name (the chip tooltip). */
  readonly label: string;
  /** Ramp start (t = 0), TRC-encoded. */
  readonly start: GradientOverlayParams['start'];
  /** Ramp end (t = 1), TRC-encoded. */
  readonly end: GradientOverlayParams['end'];
  /** Ramp geometry shipped with the preset. */
  readonly style: GradientOverlayParams['style'];
}

export const GRADIENT_PRESETS: readonly GradientPreset[] = [
  // Sourced from the uiGradients hand-picked library (uigradients.com /
  // github.com/ghosh/uiGradients gradients.json) — canonical names kept.
  // Chosen for HIGH two-stop contrast so the ramp reads clearly on real
  // imagery (the first draft palette was too close-toned to show a gradient).
  { id: 'ibiza-sunset', label: 'Ibiza Sunset', start: fromHex('#ee0979'), end: fromHex('#ff6a00'), style: 'linear' },
  { id: 'sublime-vivid', label: 'Sublime Vivid', start: fromHex('#fc466b'), end: fromHex('#3f5efb'), style: 'linear' },
  { id: 'kye-meh', label: 'Kye Meh', start: fromHex('#8360c3'), end: fromHex('#2ebf91'), style: 'linear' },
  { id: 'aqua-marine', label: 'Aqua Marine', start: fromHex('#2af598'), end: fromHex('#009efd'), style: 'linear' },
  { id: 'witching-hour', label: 'Witching Hour', start: fromHex('#c31432'), end: fromHex('#240b36'), style: 'linear' },
  { id: 'moonlit-asteroid', label: 'Moonlit Asteroid', start: fromHex('#0f2027'), end: fromHex('#2c5364'), style: 'linear' },
] as const;

/** Category-specific default parameters (used by append + enable-create paths). */
/**
 * First-release inner-glow defaults: the reference product's Inner Glow
 * dialog factory state — a pale yellow (the same factory glow colour the
 * outer glow ships), Screen blend (the factory brightening default), 5px
 * blur (the factory "size"), no choke/spread, 50% strength (the factory
 * opacity). The same "one-shot success" contract as the other categories.
 */
export function defaultInnerGlowParams(): InnerGlowParams {
  return { color: fromHex('#ffffbe'), blurRadius: 5, spreadPx: 0, strength: 0.5, blendMode: 'screen' };
}

/**
 * First-release inner-shadow defaults: the reference product's Inner Shadow
 * dialog factory state — black at Multiply, 120° light (offset computed from
 * distance 5 at 120°: (-5·cos120°, -(-5·sin120°)) in canvas y-down deltas —
 * the ring darkens the upper-left inner edge, the factory look), 5px blur,
 * no spread, full strength.
 */
export function defaultInnerShadowParams(): InnerShadowParams {
  const distance = 5;
  const rad = (120 * Math.PI) / 180;
  return {
    color: fromHex('#000000'),
    offsetX: distance * Math.cos(rad),
    offsetY: -distance * Math.sin(rad),
    blurRadius: 5,
    spreadPx: 0,
    strength: 1,
    blendMode: 'multiply',
  };
}

/** Category-specific default parameters (used by append + enable-create paths). */
export function defaultParamsFor(category: EffectCategory): StrokeParams | ShadowParams | ColorOverlayParams | OuterGlowParams | GradientOverlayParams | InnerGlowParams | InnerShadowParams {
  if (category === 'stroke') return defaultStrokeParams();
  if (category === 'colorOverlay') return defaultColorOverlayParams();
  if (category === 'outerGlow') return defaultOuterGlowParams();
  if (category === 'gradientOverlay') return defaultGradientOverlayParams();
  if (category === 'innerGlow') return defaultInnerGlowParams();
  if (category === 'innerShadow') return defaultInnerShadowParams();
  return defaultShadowParams();
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
  opts: { params?: StrokeParams | ShadowParams | ColorOverlayParams | OuterGlowParams | GradientOverlayParams | InnerGlowParams | InnerShadowParams; id?: string; enabled?: boolean } = {},
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

/** Count of instances (enabled or not) for one category — the drawer tab
 *  population (disabled instances render as OFF tabs). */
export function countEffectInstances(layer: Layer, category: EffectCategory): number {
  return getEffectChain(layer).filter((e) => e.category === category).length;
}

/**
 * Render evaluation order: category precedence first (shadow rank 0 beneath,
 * stroke rank 1 above), then the chain array order within each category. Pure
 * and stable — the prepass (prepareEffectSources) and any future raster
 * fallback MUST composite through this ordering so tab order and pixels agree.
 */
export const EFFECT_RENDER_RANK: Readonly<Record<EffectCategory, number>> = {
  // Visual stacking, bottom to top: shadow < outer glow < stroke < content
  // (with the overlay living ON the content surface). The prepass EXECUTES
  // the surface overlay BEFORE the stroke and the glow AFTER the stroke —
  // execution order and visual stacking are deliberately different axes;
  // this rank only fixes the chain evaluation order for the translator and
  // the layers-list rows.
  shadow: 0,
  outerGlow: 1,
  stroke: 2,
  // The surface overlay band: both overlays live ON the content surface.
  // The rank orders the band INTRA-BAND as color overlay beneath gradient
  // overlay (the reference product's Layer Style dialog order): the prepass
  // executes the color overlays first, then the gradients, both BEFORE the
  // stroke — each surface pass re-colours the accumulated content pixels,
  // so the later pass reads the earlier one's result.
  colorOverlay: 3,
  gradientOverlay: 4,
  // The inner-edge band: glow beneath shadow (the reference dialog order).
  // Both clip INSIDE the content silhouette — the prepass executes them on
  // the FINAL foreground (after the stroke and shadow chains), and their
  // output stays window-aligned content-extent (no ROI growth), so the next
  // family (future bevel) consumes the same geometry.
  innerGlow: 5,
  innerShadow: 6,
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
    params?: StrokeParams | ShadowParams | ColorOverlayParams | OuterGlowParams | GradientOverlayParams | InnerGlowParams | InnerShadowParams;
    /**
     * Caller-supplied id (the drawer generates one so it can activate the new
     * tab immediately — the patch return value alone cannot carry the id).
     * Omitted → a fresh generated id, the historical behaviour.
     */
    id?: string;
    /**
     * New instances arrive DISABLED by default (the "+" parametric-shell
     * precedent: an off-by-default effect can never surprise by re-painting
     * pixels the moment it lands). Explicit creators pass what they mean —
     * the drawer's eye-on-virtual passes `enabled: true` (the click itself
     * is the on), the drawer's first-parameter-edit lands the DISABLED
     * carrier with the edited values.
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
 * Remove one instance by id (the trash — deletion is UNCONDITIONAL, unlike
 * the eye which only flips `enabled`). Returns the patch, or `null` for an
 * unknown id. Deleting the last instance of a category returns it to the
 * placeholder tab ("no stroke" is an absent stroke).
 */
export function removeEffectInstance(layer: Layer, id: string): Partial<Layer> | null {
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
  params: StrokeParams | ShadowParams | ColorOverlayParams | OuterGlowParams | GradientOverlayParams | InnerGlowParams | InnerShadowParams,
): Partial<Layer> | null {
  const chain = getEffectChain(layer);
  const at = chain.findIndex((e) => e.id === id);
  if (at < 0) return null;
  const next = [...chain];
  next[at] = { ...next[at], params };
  return { effects: next };
}

/**
 * Update-or-insert parameters for a VIRTUAL tab edit (20261127 ruling):
 * when `id` resolves, behave exactly like {@link updateEffectParams}; when
 * it does NOT (the placeholder tab's pre-generated stable id), land a
 * DISABLED carrier instance with the edited values in the same patch —
 * editing an off effect's parameters must not switch it on, and the
 * instance + its first parameters must hit history as ONE step (the
 * gesture's only undo boundary), never as a separate "layer write" step.
 */
export function upsertEffectParams(
  layer: Layer,
  category: EffectCategory,
  id: string,
  params: StrokeParams | ShadowParams | ColorOverlayParams | OuterGlowParams | GradientOverlayParams | InnerGlowParams | InnerShadowParams,
): Partial<Layer> {
  const existing = updateEffectParams(layer, id, params);
  if (existing) return existing;
  return appendEffectInstance(layer, category, { id, enabled: false, params });
}

/**
 * Toggle one instance's enabled flag — the eye's PRIMARY channel (drawer
 * tab eye / layers-drawer member-row eye). Disabling KEEPS the instance so
 * its edited parameters survive the toggle; deletion is the trash's job
 * ({@link removeEffectInstance}). Returns `null` when the id is unknown.
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

/**
 * Disable every effect instance on the layer in ONE patch (the drawer's
 * "disable all" action). Disabling keeps every instance so all edited
 * parameters survive the sweep. Returns null when there is nothing to do —
 * no chain, or every instance is already disabled — so callers keep the
 * patch channel's no-op-write hygiene (a null patch never lands a Redux
 * write).
 */
export function disableAllEffectInstances(layer: Layer): Partial<Layer> | null {
  const chain = getEffectChain(layer);
  if (chain.length === 0 || chain.every((e) => !e.enabled)) return null;
  return { effects: chain.map((e) => ({ ...e, enabled: false })) };
}
