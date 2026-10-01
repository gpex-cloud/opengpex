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
 * poolBudget.ts — device-adaptive `TexturePool.maxFreeBytes` tier.
 *
 * PURE FUNCTION (no device, no side effects) so it is trivially golden-testable.
 * Maps a coarse device class onto how much FREE (cached, idle) VRAM the pool may
 * retain before LRU eviction kicks in. Because the full-canvas composite
 * target is engine-owned and resident OUTSIDE the pool, this budget governs
 * only the "many small, various-sized" transients — on a low-memory
 * integrated GPU we keep that cache tight instead of stacking 256 MiB of idle
 * transients on top of the already-resident big target.
 *
 * ⚠️ WebGPU exposes NO "true VRAM total" API. The classification is a
 * HEURISTIC over `adapterInfo` + allocation-ceiling `limits`, never a real
 * memory measurement. When in doubt it returns the larger (discrete) budget —
 * the historical default — so an unknown adapter is never starved.
 */

/** Discrete / large-VRAM tier: the historical default (unchanged behaviour). */
export const POOL_BUDGET_DISCRETE = 256 * 1024 * 1024;
/** Integrated / low-VRAM tier (Intel Iris, Apple, Mali, Adreno …). */
export const POOL_BUDGET_INTEGRATED = 64 * 1024 * 1024;

/**
 * Substrings in `vendor`/`architecture` that mark an integrated / mobile GPU
 * sharing system memory. Matched case-insensitively.
 */
export const INTEGRATED_MARKERS = ['intel', 'apple', 'mali', 'adreno'] as const;

/**
 * A `maxBufferSize` at or below the WebGPU base-minimum (256 MiB) means the
 * adapter granted NO headroom beyond the spec floor — a strong low-memory signal
 * independent of the vendor string.
 */
export const LOW_BUFFER_CEILING = 256 * 1024 * 1024;

/** The subset of adapter facts the tier decision needs. */
export interface PoolBudgetInputs {
  readonly adapterInfo: { readonly vendor: string; readonly architecture: string };
  readonly limits: { readonly maxBufferSize: number };
}

/**
 * Derive the pool's `maxFreeBytes` from the negotiated device class.
 *
 * Integrated / low-VRAM → {@link POOL_BUDGET_INTEGRATED} (64 MiB) when EITHER an
 * {@link INTEGRATED_MARKERS} substring appears in vendor/architecture, OR
 * `maxBufferSize` is a positive value at/below {@link LOW_BUFFER_CEILING}.
 * Otherwise (discrete, or unknown/zero limits) → {@link POOL_BUDGET_DISCRETE}.
 */
export function derivePoolBudget(input: PoolBudgetInputs): number {
  const tokens = `${input.adapterInfo.vendor} ${input.adapterInfo.architecture}`.toLowerCase();
  const isIntegratedVendor = INTEGRATED_MARKERS.some((m) => tokens.includes(m));

  const maxBufferSize = input.limits.maxBufferSize;
  const isLowBuffer = maxBufferSize > 0 && maxBufferSize <= LOW_BUFFER_CEILING;

  return isIntegratedVendor || isLowBuffer ? POOL_BUDGET_INTEGRATED : POOL_BUDGET_DISCRETE;
}
