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
 * GpuInfo.ts — the outward-facing GPU diagnostics snapshot.
 *
 * A plain-data record assembled synchronously by `WebGpuEngine.getGpuInfo()` and
 * surfaced through `PixelService.system.gpuInfo()`. Every source is a resident,
 * synchronous read (negotiated `Capabilities` + `TexturePool.getStats()` + the
 * engine-owned composite target's byte footprint) — no cross-thread round-trip.
 *
 * ⚠️ CONTRACT — WebGPU has NO API for "true VRAM total":
 *   • `limits.maxBufferSize` / `limits.maxTextureDimension2D` are ALLOCATION
 *     CEILINGS the adapter is willing to grant — NOT the size of physical VRAM.
 *     A 2 GiB `maxBufferSize` does not mean the card has 2 GiB free, or even 2 GiB.
 *   • `memory.*` is the ENGINE's OWN book-keeping (what the pool + composite
 *     target currently hold), NOT the driver's real resident-memory figure.
 *   Callers MUST NOT present these numbers as "hardware VRAM usage". They are for
 *   diagnostics, bug reports, and the device-tier heuristic (see `poolBudget.ts`).
 */
export interface GpuInfo {
  /**
   * `false` until a device has been negotiated (engine not `init`ed). When
   * `false` the static fields hold conservative placeholders and `memory` is all
   * zero — the shape stays stable so callers need no null checks.
   */
  readonly ready: boolean;

  // ── Static (per-device, immutable for the device's lifetime) ──

  /** Adapter identity, for diagnostics / bug reports. */
  readonly adapterInfo: {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
  };
  /** Allocation CEILINGS — see the contract note above; NOT total VRAM. */
  readonly limits: {
    readonly maxTextureDimension2D: number;
    readonly maxBufferSize: number;
  };
  /** Intermediate composite working format (`rgba16float` default). */
  readonly workingFormat: 'rgba16float' | 'rgba32float';
  /** True when the canvas exceeds `maxTextureDimension2D` and tiling is required. */
  readonly needsTiling: boolean;

  // ── Dynamic (engine book-keeping, NOT driver-reported) ──

  readonly memory: {
    /** Pool bytes currently checked out (in-use textures). */
    readonly inUseBytes: number;
    /** Pool bytes cached free (awaiting reuse or LRU eviction). */
    readonly freeBytes: number;
    /** Pool high-water-mark since construction. */
    readonly peakBytes: number;
    /**
     * The engine-owned composite target's footprint: it is
     * exact-size and resident OUTSIDE the pool, so it is absent from the pool
     * stats above and accounted separately here. `0` before the first composite.
     */
    readonly compositeTargetBytes: number;
  };
}
