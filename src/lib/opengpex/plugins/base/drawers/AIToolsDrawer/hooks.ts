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

"use client";

import { usePluginSignals } from "@opengpex/editor/core/context";
import type { BgRemoverStatus, SegStatus } from "./protocols";
import { INITIAL_STATUS, INITIAL_SEG_STATUS } from "./protocols";
import type { AIToolsDrawerSignalsMap } from "./commands.d";

// ─── SpeedEstimator ──────────────────────────────────────────────────────────

/**
 * SpeedEstimator — Sliding-window speed calculation for download progress.
 *
 * Keeps only the last 3 seconds of samples to compute a smooth, responsive
 * speed estimate. Provides both bytes/second and ETA calculation.
 *
 * Used by commands.ts for the inference download progress callback.
 */
export class SpeedEstimator {
  private samples: { time: number; bytes: number }[] = [];
  private _totalBytes = 0;
  private _currentBytes = 0;

  update(loaded: number, total: number) {
    this._currentBytes = loaded;
    this._totalBytes = total;
    this.samples.push({ time: Date.now(), bytes: loaded });
    // Keep only last 3 seconds
    const cutoff = Date.now() - 3000;
    this.samples = this.samples.filter((s) => s.time >= cutoff);
  }

  get bytesPerSecond(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.time - first.time) / 1000;
    return dt > 0 ? (last.bytes - first.bytes) / dt : 0;
  }

  get etaSeconds(): number {
    const speed = this.bytesPerSecond;
    if (speed <= 0 || this._totalBytes <= 0) return Infinity;
    return (this._totalBytes - this._currentBytes) / speed;
  }

  reset() {
    this.samples = [];
    this._totalBytes = 0;
    this._currentBytes = 0;
  }
}

// ─── useBgRemoverStatus ──────────────────────────────────────────────────────

/**
 * useBgRemoverStatus: Read the current BgRemover status from signals.
 *
 * Returns the live status object (stage, device, progress, etc.) which
 * drives the Drawer UI state machine.
 */
export function useBgRemoverStatus(): BgRemoverStatus {
  const { statusSignal } = usePluginSignals<AIToolsDrawerSignalsMap>();
  const status = statusSignal?.value as BgRemoverStatus | undefined;
  return status ?? INITIAL_STATUS;
}

// ─── useSegStatus ────────────────────────────────────────────────────────────

/**
 * useSegStatus: Read the current Segmentation status from signals.
 *
 * Returns the live SegStatus object (stage, device, candidates, etc.) which
 * drives the SegmentationPanel UI.
 */
export function useSegStatus(): SegStatus {
  const { segStatusSignal } = usePluginSignals<AIToolsDrawerSignalsMap & { segStatusSignal: { value: unknown; set: (v: unknown) => void } }>();
  const status = segStatusSignal?.value as SegStatus | undefined;
  return status ?? INITIAL_SEG_STATUS;
}
