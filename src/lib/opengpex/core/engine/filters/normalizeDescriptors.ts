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
 * Collect the various per-layer adjustment state slots (adjustments,
 * curves, levels, channelMix) into the flat, ordered `FilterDescriptor[]`
 * that both `AsyncFilterCache` (for cache-key hashing) and
 * `Canvas2dFilter` (for pixel execution) consume.
 *
 * Purpose (spec §5.5.1):
 *   Cache-key hashing REQUIRES a canonical ordering + numeric precision
 *   that is stable across renders and independent of insertion order. The
 *   normalisation rules here are the single source of truth — no other
 *   module should hand-roll `FilterDescriptor` collection.
 *
 * Rules:
 *   1. Filter descriptors are emitted in a fixed **class order**
 *      (point-ops → matrix-ops → neighborhood-ops) so the runtime hot loop
 *      can rely on curves/levels folding into LUTs before matrix ops run.
 *   2. Default / identity values are stripped — `brightness: 100` never
 *      makes it into the descriptor list so the cache-key stays stable
 *      when the user "cancels" a slider back to default.
 *   3. Numeric fields are quantized to 6 significant digits so
 *      double-precision jitter (`0.499999999` vs `0.5`) doesn't miss the
 *      cache.
 */

import type { AdjustmentState, ChannelMixState, CurvesState, LevelsState, Layer } from '@opengpex/editor/core/types';
import type { FilterDescriptor } from '@opengpex/editor/core/engine/protocol/IFilter';

// ────────────────────────────────────────────────────────────
// Number canonicalization
// ────────────────────────────────────────────────────────────

/**
 * Round to 6 significant digits. This is well above what any UI slider
 * writes, but tight enough that floating-point noise from React re-renders
 * never breaks cache identity.
 */
export function q(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n === 0) return 0;
  const digits = 6;
  const magnitude = Math.pow(10, digits - Math.ceil(Math.log10(Math.abs(n))));
  return Math.round(n * magnitude) / magnitude;
}

function qPair(p: readonly [number, number]): [number, number] {
  return [q(p[0]), q(p[1])];
}

function qTriple(t: readonly [number, number, number]): [number, number, number] {
  return [q(t[0]), q(t[1]), q(t[2])];
}

// ────────────────────────────────────────────────────────────
// Adjustments (Legacy AdjustmentDrawer state)
// ────────────────────────────────────────────────────────────

/**
 * Convert the legacy `AdjustmentState` slider bundle into individual
 * descriptors. Identity values are dropped so a "reset to default" render
 * yields the same cache key as a layer without an adjustments slot.
 */
function fromAdjustments(adj: AdjustmentState | undefined): FilterDescriptor[] {
  if (!adj) return [];
  const out: FilterDescriptor[] = [];
  if (adj.brightness !== undefined && adj.brightness !== 100) {
    out.push({ type: 'brightness', value: q(adj.brightness) });
  }
  if (adj.contrast !== undefined && adj.contrast !== 100) {
    out.push({ type: 'contrast', value: q(adj.contrast) });
  }
  if (adj.saturation !== undefined && adj.saturation !== 100) {
    out.push({ type: 'saturation', value: q(adj.saturation) });
  }
  if (adj.hueRotate !== undefined && adj.hueRotate !== 0) {
    out.push({ type: 'hueRotate', value: q(adj.hueRotate) });
  }
  if (adj.blur !== undefined && adj.blur !== 0) {
    out.push({ type: 'blur', value: q(adj.blur) });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Curves / levels / channel mix
// ────────────────────────────────────────────────────────────

function isIdentityCurve(pts: readonly [number, number][] | undefined): boolean {


  if (!pts || pts.length === 0) return true;
  if (pts.length !== 2) return false;
  const [a, b] = pts;
  return a[0] === 0 && a[1] === 0 && b[0] === 1 && b[1] === 1;
}

function fromCurves(curves: CurvesState | undefined): FilterDescriptor[] {
  if (!curves) return [];
  const channels: {
    rgb?: [number, number][];
    red?: [number, number][];
    green?: [number, number][];
    blue?: [number, number][];
  } = {};
  if (!isIdentityCurve(curves.rgb)) channels.rgb = curves.rgb!.map(qPair);
  if (!isIdentityCurve(curves.red)) channels.red = curves.red!.map(qPair);
  if (!isIdentityCurve(curves.green)) channels.green = curves.green!.map(qPair);
  if (!isIdentityCurve(curves.blue)) channels.blue = curves.blue!.map(qPair);
  if (Object.keys(channels).length === 0) return [];
  return [{ type: 'curves', channels }];
}

function isIdentityLevels(l: LevelsState | undefined): boolean {
  if (!l) return true;
  return (
    l.inputBlack === 0 &&
    l.inputWhite === 255 &&
    l.gamma === 1 &&
    l.outputBlack === 0 &&
    l.outputWhite === 255
  );
}

function fromLevels(levels: LevelsState | undefined): FilterDescriptor[] {
  if (isIdentityLevels(levels)) return [];
  const l = levels!;
  return [
    {
      type: 'levels',
      config: {
        inputBlack: q(l.inputBlack),
        inputWhite: q(l.inputWhite),
        gamma: q(l.gamma),
        outputBlack: q(l.outputBlack),
        outputWhite: q(l.outputWhite),
      },
    },
  ];
}

function isIdentityChannelMix(m: ChannelMixState | undefined): boolean {
  if (!m) return true;
  const eq = (v: readonly [number, number, number], t: [number, number, number]) =>
    v[0] === t[0] && v[1] === t[1] && v[2] === t[2];
  return (
    eq(m.red, [1, 0, 0]) &&
    eq(m.green, [0, 1, 0]) &&
    eq(m.blue, [0, 0, 1]) &&
    (!m.constant || eq(m.constant, [0, 0, 0]))
  );
}

function fromChannelMix(m: ChannelMixState | undefined): FilterDescriptor[] {
  if (isIdentityChannelMix(m)) return [];
  const mm = m!;
  return [
    {
      type: 'channelMix',
      data: {
        red: qTriple(mm.red),
        green: qTriple(mm.green),
        blue: qTriple(mm.blue),
        constant: mm.constant ? qTriple(mm.constant) : [0, 0, 0],
      },
    },
  ];
}

// ────────────────────────────────────────────────────────────
// Public entry
// ────────────────────────────────────────────────────────────

/**
 * Extract the ordered `FilterDescriptor[]` that the IFilter runtime should
 * apply to `layer`. Order matters:
 *
 *   1. Point-ops (brightness / contrast / levels / curves)
 *   2. Color matrix (saturation / hueRotate / channelMix)
 *   3. Neighborhood (blur)
 *
 * Within the point-op block, the sub-order is `brightness → contrast →
 * levels → curves` — this matches the Photoshop pipeline (levels operate
 * on the untouched image, curves are the final tone shape).
 */
export function normalizeFilterDescriptors(layer: Pick<Layer, 'adjustments' | 'curves' | 'levels' | 'channelMix'>): FilterDescriptor[] {
  const adj = fromAdjustments(layer.adjustments);

  const brightness = adj.filter(f => f.type === 'brightness');
  const contrast = adj.filter(f => f.type === 'contrast');
  const saturation = adj.filter(f => f.type === 'saturation');
  const hue = adj.filter(f => f.type === 'hueRotate');
  const blur = adj.filter(f => f.type === 'blur');

  return [
    ...brightness,
    ...contrast,
    ...fromLevels(layer.levels),
    ...fromCurves(layer.curves),
    ...saturation,
    ...hue,
    ...fromChannelMix(layer.channelMix),
    ...blur, // neighborhood — always last, see spec §5.4
  ];
}

/**
 * True when the layer has ANY non-identity descriptor. Cheap gate used by
 * `painter.ts` before consulting `AsyncFilterCache`.
 */
export function hasActiveFilters(layer: Pick<Layer, 'adjustments' | 'curves' | 'levels' | 'channelMix'>): boolean {
  return normalizeFilterDescriptors(layer).length > 0;
}

/**
 * True when the layer has ANY "advanced" (non-legacy) descriptor — i.e.
 * anything that Canvas2D `ctx.filter` cannot render natively. Legacy
 * brightness / contrast / saturation / hueRotate / blur alone stay on the
 * fast CSS-filter path.
 */
export function hasAdvancedFilters(layer: Pick<Layer, 'curves' | 'levels' | 'channelMix'>): boolean {
  return (
    !isIdentityCurve(layer.curves?.rgb) ||
    !isIdentityCurve(layer.curves?.red) ||
    !isIdentityCurve(layer.curves?.green) ||
    !isIdentityCurve(layer.curves?.blue) ||
    !isIdentityLevels(layer.levels) ||
    !isIdentityChannelMix(layer.channelMix)
  );
}

// ────────────────────────────────────────────────────────────
// Cache key (spec §5.5.1)
// ────────────────────────────────────────────────────────────

/**
 * Deterministic JSON stringifier: keys sorted lexicographically, arrays
 * kept in-order (their order is meaningful). No external dependency —
 * `JSON.stringify` with a replacer is enough for our nesting depth.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

export interface FilterCacheKeyOptions {
  /** 8 for preview / worker, 16 for the export lane. */
  bitDepth?: 8 | 16;
  /** Tile id when the cache is scoped to a single tile; null = full layer. */
  tileId?: string | null;
  /** §5.3 thumbnail level; null = full-resolution. */
  thumbLevel?: number | null;
}

/**
 * Cache key contract (spec §5.5.1):
 *
 *   { v, assetId, filters, bitDepth, tileId, thumbLevel }
 *
 * - `v`         schema version, so we can invalidate all keys en-masse.
 * - `assetId`   changes on source swap → auto-invalidates the entry.
 * - `filters`   normalized descriptor list.
 * - `bitDepth`  8-bit preview and 16-bit export must NOT share entries.
 * - `tileId`    full-layer cache uses null; tile-level cache fills in.
 * - `thumbLevel` full-res uses null; §5.3 preview thumb sets the mipmap
 *                level so drag-preview & full-res never collide.
 */
export function computeFilterCacheKey(
  layer: Pick<Layer, 'assetId' | 'adjustments' | 'curves' | 'levels' | 'channelMix'>,
  opts: FilterCacheKeyOptions = {},
): string {
  return stableStringify({
    v: 1,
    assetId: layer.assetId,
    filters: normalizeFilterDescriptors(layer),
    bitDepth: opts.bitDepth ?? 8,
    tileId: opts.tileId ?? null,
    thumbLevel: opts.thumbLevel ?? null,
  });
}
