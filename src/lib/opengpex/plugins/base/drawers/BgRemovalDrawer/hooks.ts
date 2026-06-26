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

import { useCallback, useRef } from "react";
import { useEditorState, useEditorServices } from "@opengpex/editor/core/context";
import type { BgRemovalStatus } from "./protocols";
import { INITIAL_STATUS, BG_REMOVAL_SIGNAL_STATUS } from "./protocols";

/**
 * SpeedEstimator — Sliding-window speed calculation for download progress.
 *
 * Keeps only the last 3 seconds of samples to compute a smooth, responsive
 * speed estimate. Provides both bytes/second and ETA calculation.
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

// ─── useBgRemovalStatus ──────────────────────────────────────────────────────

/**
 * useBgRemovalStatus: Read the current BgRemoval status from signals.
 *
 * Returns the live status object (stage, device, progress, etc.) which
 * drives the Drawer UI state machine.
 */
export function useBgRemovalStatus(): BgRemovalStatus {
  const { state } = useEditorState();
  const status = state.getStateSignal(BG_REMOVAL_SIGNAL_STATUS) as BgRemovalStatus | undefined;
  return status ?? INITIAL_STATUS;
}

// ─── useBgRemovalActions ─────────────────────────────────────────────────────

/**
 * useBgRemovalActions: Provides status update helpers for the BgRemoval workflow.
 *
 * Returns callbacks to update the status signal, incorporating the SpeedEstimator
 * for download progress calculations.
 */
export function useBgRemovalActions() {
  const { state } = useEditorState();
  const { actions } = useEditorServices();
  const speedEstimator = useRef(new SpeedEstimator());

  const updateStatus = useCallback(
    (patch: Partial<BgRemovalStatus>) => {
      const current = (state.getStateSignal(BG_REMOVAL_SIGNAL_STATUS) as BgRemovalStatus | undefined) ?? INITIAL_STATUS;
      actions.setStateSignal(BG_REMOVAL_SIGNAL_STATUS, { ...current, ...patch });
    },
    [state, actions]
  );

  const updateDownloadProgress = useCallback(
    (loaded: number, total: number) => {
      speedEstimator.current.update(loaded, total);
      const progress = total > 0 ? loaded / total : 0;
      updateStatus({
        stage: "downloading",
        downloadProgress: progress,
        downloadedBytes: loaded,
        totalBytes: total,
        speedBps: speedEstimator.current.bytesPerSecond,
        etaSeconds: speedEstimator.current.etaSeconds,
      });
    },
    [updateStatus]
  );

  const resetSpeed = useCallback(() => {
    speedEstimator.current.reset();
  }, []);

  return { updateStatus, updateDownloadProgress, resetSpeed };
}

// ─── useCanRemoveBg ──────────────────────────────────────────────────────────

/**
 * useCanRemoveBg: Determines if the "Remove Background" button should be enabled.
 *
 * Conditions for enabling:
 *   - An active frame exists
 *   - An active layer exists and is of type 'image'
 *   - No removal is currently in progress
 */
export function useCanRemoveBg(): { canRemove: boolean; reason: string | null } {
  const { activeFrame, activeLayer } = useEditorState();
  const status = useBgRemovalStatus();

  if (!activeFrame) {
    return { canRemove: false, reason: "No active canvas" };
  }

  if (!activeLayer) {
    return { canRemove: false, reason: "No active layer" };
  }

  if (activeLayer.type !== "image") {
    return { canRemove: false, reason: "Only image layers supported" };
  }

  if (status.stage === "loading" || status.stage === "downloading" || status.stage === "processing") {
    return { canRemove: false, reason: "Processing in progress..." };
  }

  // Check if WebGPU or WASM is available (basic check)
  if (typeof Worker === "undefined") {
    return { canRemove: false, reason: "Web Worker not supported" };
  }

  return { canRemove: true, reason: null };
}
