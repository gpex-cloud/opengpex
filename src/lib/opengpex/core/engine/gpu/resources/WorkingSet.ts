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
 * WorkingSet.ts — the ONE ledger for the engine's volatile GPU working set.
 *
 * The engine holds several classes of RESIDENT, engine-owned textures that live
 * OUTSIDE the TexturePool and were previously accounted piecemeal (only the
 * composite target had a number; the below-cache, the roi target, and the
 * resident vector/ping-pong transients were invisible to diagnostics). This
 * module aggregates ALL of them under one snapshot so pressure responses
 * (visibility-change shrink, idle eviction) and the MetricsHUD / PERF_MON
 * summaries read from a single source of truth.
 *
 * ── WHY PROVIDERS, NOT REGISTER/UNREGISTER ──
 * Every category is already owned and lifecycle-managed by exactly one engine
 * field (`compositeTexture`, `roiTexture`, `belowCacheTexture`,
 * `ResidentTransientCache`, `TexturePool`). Mirroring those lifecycles with
 * parallel register/unregister calls would double-bookkeep them — one missed
 * unregister site is a silent ledger leak. Instead the engine hands over
 * zero-arg byte providers (closures over its own fields, computed with
 * `estimateTextureBytes`) and the snapshot is always a faithful read of
 * current reality by construction. The ledger is PURE accounting: no GPU
 * objects, no side effects, trivially testable with fake providers.
 *
 * ⚠️ CONTRACT: like `GpuInfo.memory`, these numbers are the ENGINE's own
 * book-keeping, NOT driver-reported VRAM usage. WebGPU exposes no true-VRAM
 * API; do not present the total as hardware residency.
 */

/** The five volatile categories the engine can hold resident. */
export type WorkingSetCategory =
  | 'compositeTarget'
  | 'roiTarget'
  | 'belowCache'
  | 'residentTransient'
  | 'pool';

/**
 * Byte providers for each category. Every entry must be a cheap synchronous
 * read (field check + arithmetic); `snapshot()` runs per HUD poll (~1/s) and
 * per PERF_MON flush, never per frame on the hot path.
 */
export interface WorkingSetProviders {
  /** Full-channel density-scaled composite target (exact-size, non-pool). */
  readonly compositeTargetBytes: () => number;
  /** Roi-channel visible-rect composite target (exact-size, non-pool). */
  readonly roiTargetBytes: () => number;
  /** Below-layers cache of the live-edit fast path (exact-size, non-pool). */
  readonly belowCacheBytes: () => number;
  /** Resident vector-stroke / ping-pong transients (`ResidentTransientCache`). */
  readonly residentTransientBytes: () => number;
  /** TexturePool total: in-use + cached-free pooled textures. */
  readonly poolBytes: () => number;
}

/** One snapshot of the volatile working set, in bytes per category. */
export interface WorkingSetSnapshot {
  readonly compositeTargetBytes: number;
  readonly roiTargetBytes: number;
  readonly belowCacheBytes: number;
  readonly residentTransientBytes: number;
  readonly poolBytes: number;
  /** Sum of all categories — the headline "engine working set" figure. */
  readonly totalBytes: number;
}

export class WorkingSet {
  constructor(private readonly providers: WorkingSetProviders) {}

  /**
   * Read every provider once and total the categories. A throwing provider is
   * treated as 0 for that category — the ledger must never be the thing that
   * breaks a diagnostics poll or a PERF_MON flush.
   */
  snapshot(): WorkingSetSnapshot {
    const read = (fn: () => number): number => {
      try {
        const v = fn();
        return Number.isFinite(v) && v > 0 ? v : 0;
      } catch {
        return 0;
      }
    };
    const compositeTargetBytes = read(this.providers.compositeTargetBytes);
    const roiTargetBytes = read(this.providers.roiTargetBytes);
    const belowCacheBytes = read(this.providers.belowCacheBytes);
    const residentTransientBytes = read(this.providers.residentTransientBytes);
    const poolBytes = read(this.providers.poolBytes);
    return {
      compositeTargetBytes,
      roiTargetBytes,
      belowCacheBytes,
      residentTransientBytes,
      poolBytes,
      totalBytes:
        compositeTargetBytes +
        roiTargetBytes +
        belowCacheBytes +
        residentTransientBytes +
        poolBytes,
    };
  }
}

/** A `WorkingSetSnapshot` collapsed to the short `c=… r=… b=… t=… p=…` form. */
export function formatWorkingSetMiB(s: WorkingSetSnapshot): string {
  const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  return (
    `c=${mib(s.compositeTargetBytes)} r=${mib(s.roiTargetBytes)} ` +
    `b=${mib(s.belowCacheBytes)} t=${mib(s.residentTransientBytes)} ` +
    `p=${mib(s.poolBytes)} total=${mib(s.totalBytes)}MiB`
  );
}
