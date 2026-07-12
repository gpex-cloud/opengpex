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
 * Magic-Wand Worker Protocol
 *
 * Wire-level types for the request / response exchanged between the main
 * thread (`client.ts`) and the wand worker (`wand.worker.ts`).
 *
 * Design notes (per phase1_irregular_clip_spec §6.2):
 *   - Pixel buffer is sent as Transferable `ArrayBuffer` so a 4K (~32 MB RGBA)
 *     image takes <1 ms to hand off — postMessage with structured-clone would
 *     stall the main thread by ~100 ms.
 *   - `reqId` lets the client correlate responses if a stale request is still
 *     in flight when a new click arrives. The current single-request-per-click
 *     UX means we reject overlap, but we keep the field for future
 *     "interactive tolerance preview" UX.
 *   - Worker is fire-and-respond — we do NOT keep state across messages.
 */

/** Main thread → Worker */
export interface WandRequest {
  /** Correlation id (echoed back). */
  reqId: number;

  /**
   * Layer-local raster pixels (RGBA8). The buffer is detached on postMessage
   * — caller MUST NOT touch it after sending.
   */
  imageData: {
    data: ArrayBuffer;
    width: number;
    height: number;
  };

  /** Click point in layer-local integer pixel coordinates. */
  seed: { x: number; y: number };

  /**
   * Color tolerance (0–255). Worker uses an L1 (Manhattan) distance over RGB
   * and admits a pixel iff ΔR + ΔG + ΔB ≤ tolerance × 3. Alpha must be > 0.
   *
   * Larger values select more pixels of similar color; 32 is a sane default
   * for photographs, 0 is "exact-match-only" (suitable for vector / pixel art).
   */
  tolerance: number;

  /**
   * Douglas–Peucker simplification tolerance, in layer-local distance units.
   * The caller is expected to scale to the current zoom (typically `1/scale`
   * so it equals roughly one screen pixel). Worker drops vertices whose
   * perpendicular distance to the current segment is below this value.
   */
  simplifyEpsilon: number;

  /**
   * `true` (default Photoshop behavior) — only flood the connected component
   *        reachable from `seed` via 4-neighborhood traversal.
   * `false` — admit any pixel anywhere in the image whose color is within
   *        tolerance of the seed (Photoshop "Use All Layers" / "Non-contiguous").
   */
  contiguous: boolean;
}

/** Worker → Main thread */
export interface WandResponse {
  /** Correlation id (mirrors the request). */
  reqId: number;

  /**
   * Layer-local vector contours.
   *   rings[0]   — outer boundary (CW)
   *   rings[1+]  — internal holes (CCW)
   * EMPTY array means "no useful selection" (e.g. seed on transparent /
   * post-RDP collapse / flood produced full image which we deliberately
   * reject as not actionable).
   */
  rings: { x: number; y: number }[][];

  /** Optional debug stats — `client.ts` may surface these to DevTools. */
  debug?: {
    floodPixels: number;
    ringsBeforeFilter?: number;
    ringsAfterFilter?: number;
    rawContourPoints: number;
    simplifiedPoints: number;
    ms: number;
  };

  /** Set when the worker hit an internal failure (caller should fall back). */
  error?: string;
}

