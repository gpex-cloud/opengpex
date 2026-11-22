/**
 * Preset file import / export — the versioned JSON envelope protocol.
 *
 * An exported look travels as a v2 envelope carrying the ordered chain
 * verbatim (a compounded look merged into one state renders differently than
 * the screen). Parsing is a strict whitelist: unknown fields are dropped,
 * numbers are clamped to sane ranges, and anything structurally impossible
 * (wrong format/version, absurd curve point counts, oversized chains) rejects
 * the whole file — imported data must never reach pluginConfig unvalidated.
 * Legacy v1 envelopes (single merged `state`) are converted on import.
 *
 * @module plugins/base/drawers/AdjustmentDrawer/presets/preset-io
 */

import type {
  AdjustmentState,
  CurvePoints,
  CurvesState,
  LevelsState,
} from '@opengpex/editor/core/types/models';
import type { PresetChainEntry, PresetGradeState } from './preset-chain';


// ─── Preset file import / export ───────────────────────────────────────────────

/** Version bound for an imported chain — more stages is garbage, not a look. */
const MAX_PRESET_CHAIN_ENTRIES = 64;

/**
 * Versioned envelope a custom preset travels in when exported as a JSON file.
 * `format` / `version` let a future schema change reject or migrate old files
 * instead of silently misreading them.
 *
 * Version history:
 * - v1 carried a single merged `state`; superseded by the chain-snapshot
 *   model (a compounded look merged into one state renders differently than
 *   the screen). v1 files are still imported: the state converts to a
 *   single-entry chain, which is semantically exact for what v1 stored.
 * - v2 carries the ordered `chain` verbatim.
 */
export interface FilterPresetEnvelope {
  format: 'opengpex-filter-preset';
  version: 2;
  name: string;
  chain: PresetChainEntry[];
}

/** Discriminator string every exported preset file carries. */
export const PRESET_FILE_FORMAT = 'opengpex-filter-preset';
/** The envelope version this editor emits. */
export const PRESET_FILE_VERSION = 2;

/**
 * Build the exact JSON text of an exported preset file from a name and a
 * grade chain. Pure (no DOM): the panel owns the browser download mechanics,
 * and this builder is what the unit tests lock.
 */
export function buildPresetEnvelope(name: string, chain: PresetChainEntry[]): string {
  const envelope: FilterPresetEnvelope = {
    format: PRESET_FILE_FORMAT,
    version: PRESET_FILE_VERSION,
    name,
    chain,
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * Derive a canonical download filename from a preset name: a stable app
 * prefix, the ASCII slug of the preset name, and a short export timestamp
 * (YYYYMMDD) so repeated exports of the same look never collide on disk.
 * Example: "Custom Look" → `opengpex-preset-custom-look-20261122.json`.
 */
export function presetFileName(name: string, now: Date = new Date()): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const stamp = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  return `opengpex-preset-${slug || 'custom-look'}-${stamp}.json`;
}

/**
 * Import validation outcome. `ok: false` carries a short user-facing English
 * message; the panel renders it inline and never touches pluginConfig. The
 * success shape is always the normalized chain (a v1 file converts its single
 * state into a one-entry chain), so imports and local saves share one type.
 */
export type ParsedImport =
  | { ok: true; name: string; chain: PresetChainEntry[] }
  | { ok: false; error: string };

// Per-field clamp ranges mirroring the slider grids the panels can produce.
const ADJUSTMENT_PERCENT_MIN = 0;
const ADJUSTMENT_PERCENT_MAX = 200;
const HUE_MIN = -360;
const HUE_MAX = 360;
const GAMMA_MIN = 0.1;
const GAMMA_MAX = 10;
const BALANCE_MIN = -100;
const BALANCE_MAX = 100;
// Channel-mix weights are unbounded in principle (creative negative/over-unit
// weights are legal); this generous bound only blocks absurd magnitudes.
const MIX_MIN = -10;
const MIX_MAX = 10;
/** Maximum anchors accepted per curve — more is garbage, not a usable curve. */
const MAX_CURVE_POINTS = 64;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

/**
 * Whitelist a numeric field: only finite numbers survive, clamped to
 * `[min, max]`. Returns `undefined` when the field is absent (optional) or
 * not a finite number (poisoned) — the caller distinguishes those two cases
 * when the field is required.
 */
function numField(
  src: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = src[key];
  return isFiniteNumber(v) ? clamp(v, min, max) : undefined;
}

/**
 * Whitelist one triple row (color balance axes, channel mix weights): exactly
 * three finite numbers, each clamped to `[min, max]`. Anything else (wrong
 * arity, NaN/Infinity, non-numbers) rejects the row outright.
 */
function tripleRow(
  src: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): [number, number, number] | undefined {
  const v = src[key];
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  if (!v.every(isFiniteNumber)) return undefined;
  return [clamp(v[0], min, max), clamp(v[1], min, max), clamp(v[2], min, max)];
}

/**
 * Whitelist one curve channel: a bounded list of `[x, y]` anchor pairs with
 * both coordinates clamped into `[0, 1]`. More than `MAX_CURVE_POINTS`
 * anchors, a malformed anchor, or a non-finite coordinate rejects the whole
 * channel (and therefore the envelope) — truncation could silently change a
 * hand-authored curve's shape.
 */
function curveChannel(src: Record<string, unknown>, key: string): CurvePoints | undefined {
  const v = src[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_CURVE_POINTS) return undefined;
  const pts: CurvePoints = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2 || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) {
      return undefined;
    }
    pts.push([clamp(p[0], 0, 1), clamp(p[1], 0, 1)]);
  }
  return pts;
}

/**
 * Strictly validate and whitelisted-clone the envelope's `state` arm. Unknown
 * fields are dropped entirely, numbers are clamped into their slider ranges,
 * and any structurally invalid value (non-finite, wrong shape, absurd size)
 * rejects the whole envelope — imported data is untrusted and must never
 * reach pluginConfig unvalidated.
 *
 * Returns `null` when the state carries no recognizable grade arm at all (a
 * preset that does nothing is rejected rather than saved as a no-op card).
 */
function parsePresetState(raw: unknown): PresetGradeState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const state: PresetGradeState = {};
  let hasAny = false;

  // ── adjustments: numeric subset only (blur / edgeFeather are excluded
  //    from the preset schema by the same rule extraction follows) ──
  if (src.adjustments !== undefined) {
    const a = src.adjustments;
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return null;
    const armSrc = a as Record<string, unknown>;
    for (const key of ['brightness', 'contrast', 'saturation', 'hueRotate'] as const) {
      if (armSrc[key] === undefined) continue;
      if (!isFiniteNumber(armSrc[key])) return null;
    }
    const arm: Partial<AdjustmentState> = {};
    for (const key of ['brightness', 'contrast', 'saturation', 'hueRotate'] as const) {
      const [min, max] = key === 'hueRotate' ? [HUE_MIN, HUE_MAX] : [ADJUSTMENT_PERCENT_MIN, ADJUSTMENT_PERCENT_MAX];
      const v = numField(armSrc, key, min, max);
      if (v !== undefined) {
        arm[key] = v;
        hasAny = true;
      }
    }
    if (Object.keys(arm).length > 0) state.adjustments = arm;
  }

  // ── curves ──
  if (src.curves !== undefined) {
    const c = src.curves;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return null;
    const armSrc = c as Record<string, unknown>;
    const arm: CurvesState = {};
    for (const channel of ['rgb', 'red', 'green', 'blue'] as const) {
      if (armSrc[channel] === undefined) continue;
      const pts = curveChannel(armSrc, channel);
      if (!pts) return null;
      arm[channel] = pts;
      hasAny = true;
    }
    if (Object.keys(arm).length > 0) state.curves = arm;
  }

  // ── levels ──
  if (src.levels !== undefined) {
    const l = src.levels;
    if (typeof l !== 'object' || l === null || Array.isArray(l)) return null;
    const armSrc = l as Record<string, unknown>;
    for (const key of ['inputBlack', 'inputWhite', 'gamma', 'outputBlack', 'outputWhite'] as const) {
      if (armSrc[key] === undefined) continue;
      if (!isFiniteNumber(armSrc[key])) return null;
    }
    const arm: Partial<LevelsState> = {};
    for (const key of ['inputBlack', 'inputWhite', 'outputBlack', 'outputWhite'] as const) {
      const v = numField(armSrc, key, 0, 255);
      if (v !== undefined) {
        arm[key] = v;
        hasAny = true;
      }
    }
    const gamma = numField(armSrc, 'gamma', GAMMA_MIN, GAMMA_MAX);
    if (gamma !== undefined) {
      arm.gamma = gamma;
      hasAny = true;
    }
    if (Object.keys(arm).length > 0) state.levels = arm;
  }

  // ── colorBalance (preserveLuminosity is not part of the preset schema;
  //    application always writes the `true` default) ──
  if (src.colorBalance !== undefined) {
    const b = src.colorBalance;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return null;
    const armSrc = b as Record<string, unknown>;
    const arm: PresetGradeState['colorBalance'] = {};
    for (const key of ['shadows', 'midtones', 'highlights'] as const) {
      if (armSrc[key] === undefined) continue;
      const row = tripleRow(armSrc, key, BALANCE_MIN, BALANCE_MAX);
      if (!row) return null;
      arm[key] = row;
      hasAny = true;
    }
    if (Object.keys(arm).length > 0) state.colorBalance = arm;
  }

  // ── channelMix ──
  if (src.channelMix !== undefined) {
    const m = src.channelMix;
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
    const armSrc = m as Record<string, unknown>;
    const arm: NonNullable<PresetGradeState['channelMix']> = {};
    for (const key of ['red', 'green', 'blue', 'constant'] as const) {
      if (armSrc[key] === undefined) continue;
      const row = tripleRow(armSrc, key, MIX_MIN, MIX_MAX);
      if (!row) return null;
      arm[key] = row;
      hasAny = true;
    }
    if (Object.keys(arm).length > 0) state.channelMix = arm;
  }

  return hasAny ? state : null;
}

/**
 * Strictly validate one chain entry: its `grade` goes through the same
 * whitelist / clamping rules as a v1 state, and an optional boolean
 * `enabled` flag survives only when well-formed. Returns `null` for any
 * structurally invalid entry.
 */
function parsePresetChainEntry(raw: unknown): PresetChainEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const grade = parsePresetState(src.grade);
  if (!grade) return null;
  const entry: PresetChainEntry = { grade, enabled: true };
  if (src.enabled !== undefined) {
    if (typeof src.enabled !== 'boolean') return null;
    entry.enabled = src.enabled;
  }
  return entry;
}

/**
 * Strictly validate an imported v2 `chain`: a bounded array of well-formed
 * entries. A chain that parses but carries no grade arm at all is rejected —
 * a preset that does nothing would only confuse.
 */
function parsePresetChain(raw: unknown): PresetChainEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PRESET_CHAIN_ENTRIES) return null;
  const chain: PresetChainEntry[] = [];
  for (const entry of raw) {
    const parsed = parsePresetChainEntry(entry);
    if (!parsed) return null;
    chain.push(parsed);
  }
  return chain;
}

/**
 * Parse and strictly validate the text of an imported preset file. This is
 * the ONLY path imported data may take toward the custom-preset list: every
 * field is whitelisted per the preset shapes, clamped into range, and
 * anything unrecognizable rejects the file with a plain-English message.
 *
 * Version handling:
 * - v2 (current): the ordered `chain` is validated entry by entry and kept
 *   verbatim — compounding order is part of the look.
 * - v1 (legacy): the single merged `state` converts to a one-entry chain,
 *   which is exactly what a v1 file stored.
 * - Anything else (wrong format string, unknown version) is rejected.
 *
 * A file whose grade content is recognized but empty ("parses but adjusts
 * nothing") is rejected as well — saving a card that does nothing would only
 * confuse.
 */
export function parseImportedPresetEnvelope(raw: string): ParsedImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Not a valid preset file' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'Not a valid preset file' };
  }
  const env = parsed as Record<string, unknown>;
  if (env.format !== PRESET_FILE_FORMAT) {
    return { ok: false, error: 'Not a valid preset file' };
  }
  if (env.version !== 1 && env.version !== 2) {
    return { ok: false, error: 'Unsupported preset file version' };
  }
  let chain: PresetChainEntry[] | null;
  if (env.version === 1) {
    const state = parsePresetState(env.state);
    chain = state ? [{ grade: state, enabled: true }] : null;
  } else {
    chain = parsePresetChain(env.chain);
  }
  if (!chain) {
    return { ok: false, error: 'Preset file has no valid adjustments' };
  }
  // Sanitize the name: trimmed, single-line, bounded; empty names fall back
  // to the panel's collision-aware default.
  const name =
    typeof env.name === 'string'
      ? env.name.replace(/\s+/g, ' ').trim().slice(0, 40)
      : '';
  return { ok: true, name, chain };
}

// ─── Strength interpolation ────────────────────────────────────────────────────

