/**
 * Preset chain kernel — schema, normalization, extraction, interpolation.
 *
 * The chain is the SINGLE source of truth for a look: rendering consumes the
 * layer's adjustMasks sequentially (one stage per enabled mask, in array
 * order), and this module speaks the same shape — a preset's payload is an
 * ordered list of partial grade stages, never a merged summary. Extraction
 * serializes a live chain verbatim; apply writes stages back as masks; the
 * interpreter blends each stage toward identity independently so the staged
 * compounding the screen shows survives at every strength.
 *
 * @module plugins/base/drawers/AdjustmentDrawer/presets/preset-chain
 */

import type {
  AdjustmentMask,
  AdjustmentState,
  ColorBalanceState,
  CurvePoints,
  CurvesState,
  LevelsState,
} from '@opengpex/editor/core/types/models';

export const PRESET_IDENTITY = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  hueRotate: 0,
  blur: 0,
  edgeFeather: 0,
  levels: { inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 },
  channelMixRow: [1, 0, 0] as [number, number, number],
  channelMixConstant: [0, 0, 0] as [number, number, number],
  balanceAxis: 0,
} as const;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Partial grade arms a preset (or a strength-resolved preset) may carry. */
export interface PresetGradeState {
  adjustments?: Partial<AdjustmentState>;
  curves?: CurvesState;
  levels?: Partial<LevelsState>;
  colorBalance?: Partial<Omit<ColorBalanceState, 'preserveLuminosity'>>;
  channelMix?: Partial<{
    red: [number, number, number];
    green: [number, number, number];
    blue: [number, number, number];
    constant: [number, number, number];
  }>;
}

/**
 * One stage of a preset's grade chain — the payload shape mirrors the grade
 * half of an `AdjustmentMask` (partial grade arms exactly), minus the fields
 * a preset does not carry (id, selection snapshot, origin/provenance tags).
 * `enabled: false` marks a stage that application skips; absent means enabled.
 */
export interface PresetChainEntry {
  grade: PresetGradeState;
  enabled?: boolean;
}

/**
 * Preset groups. `'custom'` is user-saved looks (never authored in the
 * built-in table); the panel renders it as its own trailing section.
 */
export type FilterPresetGroup = 'basic' | 'film' | 'tone' | 'mood' | 'custom';

/**
 * Display metadata + grade payload for one preset.
 *
 * TWO PAYLOAD SHAPES, ONE RESOLUTION PATH (`resolvePresetChain`):
 * - built-ins carry `state` — they are single-stage by construction (one
 *   authored grade arms bundle), so the single-state authoring shape stays;
 * - saved / imported customs carry `chain` — an ORDERED list of partial grade
 *   stages extracted from the layer's `adjustMasks` chain, so a look that
 *   compounds a category across several masks (e.g. two saturations, or two
 *   curves masks composing per channel) round-trips EXACTLY as it renders,
 *   instead of being merged into one semantically different grade.
 */
export interface FilterPreset {
  /** Stable identifier — persisted nowhere (presets are applied, not linked). */
  id: string;
  /** i18n-ready name key (e.g. `presets.vivid`); panels localize via it. */
  nameKey: string;
  /** English fallback label shown when no translation exists. */
  name: string;
  group: FilterPresetGroup;
  /** Single-stage grade payload (built-in presets). */
  state?: PresetGradeState;
  /** Ordered grade stages (saved / imported custom presets). */
  chain?: PresetChainEntry[];
}

/**
 * The single normalization every preset consumer goes through: a preset's
 * ordered grade stages are its `chain` when present, otherwise the single
 * `state` wrapped as a one-entry chain. No consumer reads `state` or `chain`
 * directly — this is the only place the two authoring shapes meet, so
 * built-ins and customs share one apply / thumbnail / export path.
 */
export function resolvePresetChain(preset: FilterPreset): PresetChainEntry[] {
  if (preset.chain && preset.chain.length > 0) return preset.chain;
  if (preset.state) return [{ grade: preset.state, enabled: true }];
  return [];
}


// ─── Strength tiers ────────────────────────────────────────────────────────────

/**
 * Discrete preset strength — the continuous slider was replaced by three
 * named tiers so a one-click filter stays a one-decision interaction.
 * Each tier maps to the interpolation parameter `t` the preset commands
 * already understand (0 = neutral, 1 = the preset as authored).
 */
export type PresetStrengthTier = 'weak' | 'medium' | 'strong';

/** Row shape of the exported tier table (structural — never imported by name). */
interface PresetStrengthTierDef {
  key: PresetStrengthTier;
  /** English label rendered on the segmented control. */
  label: string;
  /** Interpolation parameter this tier feeds into the preset commands. */
  t: number;
}

/**
 * The three tiers in display order. Values chosen so WEAK is a perceptible
 * but subtle grade, MEDIUM is the "as the designer intended" default, and
 * STRONG is the full authored preset.
 */
export const PRESET_STRENGTH_TIERS: readonly PresetStrengthTierDef[] = [
  { key: 'weak', label: 'Weak', t: 0.35 },
  { key: 'medium', label: 'Medium', t: 0.7 },
  { key: 'strong', label: 'Strong', t: 1.0 },
] as const;

/** Tier applied when a preset card is clicked without an explicit tier choice. */
export const DEFAULT_PRESET_TIER: PresetStrengthTier = 'medium';

/** Map a tier to its interpolation parameter `t` (unknown tiers fall back to the default tier). */
export function tierToStrength(tier: PresetStrengthTier): number {
  const def = PRESET_STRENGTH_TIERS.find((d) => d.key === tier);
  return (def ?? PRESET_STRENGTH_TIERS.find((d) => d.key === DEFAULT_PRESET_TIER)!).t;
}

// ─── Custom presets (save current look) ────────────────────────────────────────

/** Maximum user-saved filter presets kept per editor (oldest evicted first). */
export const CUSTOM_FILTER_PRESET_CAP = 20;

/**
 * Append a custom preset to the saved list, evicting the oldest entries once
 * the cap is reached (the newest survive — same `slice(-n)` convention the
 * brush presets use).
 */
export function appendCustomFilterPreset(
  presets: FilterPreset[],
  preset: FilterPreset,
): FilterPreset[] {
  return [...presets, preset].slice(-CUSTOM_FILTER_PRESET_CAP);
}

/**
 * The per-layer grade chain shape extraction reads. Structural subset of the
 * real `AdjustmentMask` (id / shape / provenance tags are irrelevant to a
 * color look) so the function stays pure and trivially unit-testable.
 */
export interface GradeMaskLike {
  category: string;
  /** Disabled masks carry no stage — the look the screen shows skips them. */
  enabled?: boolean;
  /** The mask's grade bundle, keyed by the category's arm key (`adjustments` for basic). */
  grade: unknown;
}

/** The grade-arm key each mask category writes into its grade bundle. */
const CHAIN_ARM_KEY: Record<string, string> = {
  basic: 'adjustments',
  curves: 'curves',
  levels: 'levels',
  colorBalance: 'colorBalance',
  channelMix: 'channelMix',
};

/**
 * Extract a custom preset's grade CHAIN from a layer's `adjustMasks` chain.
 *
 * CHAIN-SNAPSHOT RULES (the saved look must render identically to the screen,
 * so compounding is preserved rather than collapsed):
 * - One chain entry per ENABLED grade-bearing mask, in chain order (= render
 *   order). NO merging, NO dedup: two basic masks saturating 81.8 then 200
 *   stay two stages, because the renderer applies them sequentially and a
 *   merged single stage would compute a different result.
 * - Each entry's `grade` holds the mask's own arm under its category key.
 *   Partial fields are preserved per mask — NO cross-mask merging, NO dedup —
 *   but arms the renderer reads field-by-field with no internal defaults
 *   (`levels`, `colorBalance`, `channelMix` — the stage translator reads their
 *   numbers directly, unlike the `?? identity` basic arm) are normalized to
 *   fully-formed arms by filling identity values for absent fields. This keeps
 *   application a verbatim write and the save → apply → re-save round-trip
 *   byte-stable: apply fills the same defaults, so re-extraction reproduces
 *   the saved entry exactly.
 * - Only grade payloads are captured. A frozen selection snapshot (`shape`)
 *   is a spatial concern and is dropped by construction — a preset is a color
 *   look, not a region. `blur` / `edgeFeather` are stripped from basic arms
 *   (a deliberate decision: blur is a layer effect, not a color look) and
 *   `preserveLuminosity` is stripped from colorBalance arms (the preset
 *   schema omits it; application always writes the `true` default).
 *
 * Returns `null` when the chain carries no grade-bearing enabled mask at all
 * — the save button is disabled in that state (nothing to save).
 */
export function extractPresetChainFromMasks(masks: GradeMaskLike[] | undefined): PresetChainEntry[] | null {
  if (!masks || masks.length === 0) return null;

  const chain: PresetChainEntry[] = [];
  for (const m of masks) {
    if (m.enabled === false) continue;
    const key = CHAIN_ARM_KEY[m.category];
    if (!key) continue; // not a grade category — nothing a preset can carry
    const arm = (m.grade as Record<string, unknown> | undefined)?.[key] as
      | Record<string, unknown>
      | undefined;
    if (!arm) continue;

    let captured: Record<string, unknown>;
    if (m.category === 'basic') {
      // Whitelist the four preset-carried numeric fields; `blur` and
      // `edgeFeather` deliberately not copied (see doc above).
      const src = arm as Record<string, number | undefined>;
      captured = {};
      for (const field of ['brightness', 'contrast', 'saturation', 'hueRotate'] as const) {
        if (src[field] !== undefined) captured[field] = src[field];
      }
    } else if (m.category === 'levels') {
      // Fully-formed arm (identity fill for absent fields — see doc above).
      const src = arm as Partial<LevelsState>;
      captured = {
        inputBlack: src.inputBlack ?? PRESET_IDENTITY.levels.inputBlack,
        inputWhite: src.inputWhite ?? PRESET_IDENTITY.levels.inputWhite,
        gamma: src.gamma ?? PRESET_IDENTITY.levels.gamma,
        outputBlack: src.outputBlack ?? PRESET_IDENTITY.levels.outputBlack,
        outputWhite: src.outputWhite ?? PRESET_IDENTITY.levels.outputWhite,
      };
    } else if (m.category === 'colorBalance') {
      // Fully-formed arm; `preserveLuminosity` is stripped — the preset schema
      // omits it and application always writes the `true` default.
      const { preserveLuminosity: _pl, ...balance } = arm;
      captured = {
        shadows: balance.shadows ?? [0, 0, 0],
        midtones: balance.midtones ?? [0, 0, 0],
        highlights: balance.highlights ?? [0, 0, 0],
      };
    } else if (m.category === 'channelMix') {
      // Fully-formed arm (identity rows for absent rows — see doc above).
      const src = arm as Record<string, [number, number, number] | undefined>;
      captured = {
        red: src.red ?? [1, 0, 0],
        green: src.green ?? [0, 1, 0],
        blue: src.blue ?? [0, 0, 1],
        constant: src.constant ?? [0, 0, 0],
      };
    } else {
      // curves: shallow-clone the arm verbatim — every channel the mask
      // defines is exactly what this stage composes.
      captured = { ...arm };
    }
    if (Object.keys(captured).length === 0) continue;
    chain.push({ grade: { [key]: captured } as PresetGradeState, enabled: true });
  }

  return chain.length > 0 ? chain : null;
}

// ─── Strength interpolation ────────────────────────────────────────────────────

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Evaluate a base curve's output at anchor `x` (linear interpolation between
 * the surrounding anchors — good enough for strength interpolation, which
 * only needs a sensible "where the base curve sits" reference).
 */
function sampleCurveAt(points: CurvePoints | undefined, x: number): number {
  if (!points || points.length === 0) return x; // identity
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (x <= b[0]) {
      const span = b[0] - a[0];
      return span > 0 ? lerp(a[1], b[1], (x - a[0]) / span) : b[1];
    }
  }
  return points[points.length - 1][1];
}

/**
 * Interpolate a preset's curves arm between a base curves state and the
 * preset's target. Anchor X positions come from the preset; each anchor's Y
 * is lerped from the base curve's value at that X (identity line when the
 * base has no such channel) toward the preset's Y. Channels present only in
 * the base pass through untouched.
 */
function lerpCurves(
  base: CurvesState | undefined,
  target: CurvesState,
  t: number,
): CurvesState {
  const out: CurvesState = { ...base };
  for (const channel of ['rgb', 'red', 'green', 'blue'] as const) {
    const pts = target[channel];
    if (!pts) continue;
    const basePts = base?.[channel];
    out[channel] = pts.map(([x, y]) => [x, lerp(sampleCurveAt(basePts, x), y, t)] as [number, number]);
  }
  return out;
}

/**
 * Apply preset strength — the pure interpolation core of the presets feature.
 *
 * For every field the preset defines, the output value is the linear blend
 * `base + (preset - base) * t` where `base` is the caller-supplied baseline
 * (pass `PRESET_IDENTITY`-shaped state for the usual "from neutral" blend).
 * Curves anchors interpolate their Y against the base curve's value at the
 * anchor's X. Fields the preset does not define pass through from `base`.
 *
 * Contracts pinned by the golden tests:
 * - `t = 0` reproduces `base` exactly (neutral passthrough),
 * - `t = 1` reproduces the preset exactly (endpoint fidelity),
 * - `t = 0.5` lands midway per field (midpoint accuracy).
 */
export function applyPresetStrength(
  base: PresetGradeState,
  preset: PresetGradeState,
  t: number,
): PresetGradeState {
  const k = clamp01(t);
  // t = 0 is the exact baseline (neutral passthrough) — return without
  // introducing any arm keys the preset would otherwise materialize.
  if (k === 0) return { ...base };
  const out: PresetGradeState = { ...base };

  if (preset.adjustments) {
    const merged: Partial<AdjustmentState> = { ...base.adjustments };
    const src = base.adjustments ?? {};
    for (const [key, target] of Object.entries(preset.adjustments) as Array<[keyof AdjustmentState, number]>) {
      merged[key] = lerp(src[key] ?? PRESET_IDENTITY[key as 'brightness'], target, k);
    }
    out.adjustments = merged;
  }
  if (preset.levels) {
    const merged: Partial<LevelsState> = { ...base.levels };
    const src = { ...PRESET_IDENTITY.levels, ...(base.levels ?? {}) };
    for (const [key, target] of Object.entries(preset.levels) as Array<[keyof LevelsState, number]>) {
      merged[key] = lerp(src[key], target, k);
    }
    out.levels = merged;
  }
  if (preset.colorBalance) {
    const merged: PresetGradeState['colorBalance'] = { ...base.colorBalance };
    const src = base.colorBalance ?? {};
    for (const key of ['shadows', 'midtones', 'highlights'] as const) {
      const target = preset.colorBalance[key];
      if (!target) continue;
      const from = src[key] ?? [0, 0, 0];
      merged[key] = [
        lerp(from[0], target[0], k),
        lerp(from[1], target[1], k),
        lerp(from[2], target[2], k),
      ];
    }
    out.colorBalance = merged;
  }
  if (preset.channelMix) {
    const merged: PresetGradeState['channelMix'] = { ...base.channelMix };
    const src = base.channelMix ?? {};
    for (const key of ['red', 'green', 'blue', 'constant'] as const) {
      const target = preset.channelMix[key];
      if (!target) continue;
      const identity = key === 'constant' ? PRESET_IDENTITY.channelMixConstant : PRESET_IDENTITY.channelMixRow;
      const from = src[key] ?? identity;
      merged[key] = [
        lerp(from[0], target[0], k),
        lerp(from[1], target[1], k),
        lerp(from[2], target[2], k),
      ];
    }
    out.channelMix = merged;
  }
  if (preset.curves) {
    out.curves = lerpCurves(base.curves, preset.curves, k);
  }
  return out;
}

/**
 * The neutral baseline every preset blends from — an empty grade. Feeding
 * this into `applyPresetStrength` with `t = 0` yields a no-op grade (the
 * "reset to neutral" endpoint of the second-click interaction).
 */
export const NEUTRAL_PRESET_STATE: PresetGradeState = {};

/**
 * Resolve a preset's grade chain at a strength parameter `t`.
 *
 * Each chain entry blends independently from identity toward its authored
 * grade (disabled entries are dropped — a skipped stage contributes nothing).
 * Per-entry blending is what makes strength meaningful for a CHAIN: every
 * stage runs its full effect at a fraction of its own magnitude, so the
 * staged compounding the screen shows survives at every tier. Built-in
 * presets carry exactly one entry, so for them this is identical to
 * interpolating their single state — the same math, one stage.
 */
export function applyPresetChainStrength(
  chain: PresetChainEntry[],
  t: number,
): PresetChainEntry[] {
  const k = clamp01(t);
  const out: PresetChainEntry[] = [];
  for (const entry of chain) {
    if (entry.enabled === false) continue;
    out.push({
      grade: applyPresetStrength(NEUTRAL_PRESET_STATE, entry.grade, k),
      enabled: true,
    });
  }
  return out;
}

// ─── Selection & strength policy ───────────────────────────────────────────────

/**
 * The selected preset for the highlight, read from the active layer's
 * preset-owned chain: the first `origin: 'preset'` mask's `fromPreset` id
 * (all masks in one application share the id), looked up across built-ins +
 * saved customs. Pure and exported so tests can pin the lookup contract.
 *
 * A chain without the id (legacy documents, or masks written before the
 * field existed) highlights nothing; an id whose preset was deleted from the
 * saved list also finds no card. Both states leave the presets-panel Reset
 * fully functional — reset removes masks by `origin`, never by this id.
 */
export function findSelectedPresetId(masks: AdjustmentMask[] | undefined): string | null {
  const owned = masks?.find((m) => m.origin === 'preset');
  return owned?.fromPreset ?? null;
}

/**
 * The interpolation strength a preset click applies at. Built-ins blend from
 * neutral through the active tier; custom presets always apply at t = 1 —
 * the saved state IS the final look, and re-interpolating it at the Medium
 * default would deform every value (a 0.7 blend of an already-combined look
 * is a different look, not a weaker one). Exported pure so tests pin the
 * rule without rendering the panel.
 */
export function presetApplyStrength(preset: FilterPreset, tier: PresetStrengthTier): number {
  return preset.group === 'custom' ? 1 : tierToStrength(tier);
}

