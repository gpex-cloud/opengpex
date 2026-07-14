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

'use client';

import React from 'react';
import { Loader2, X } from 'lucide-react';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatSpeed(bps: number): string {
  if (bps === 0) return '';
  return `${formatBytes(bps)}/s`;
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ModelDownloadSectionProps {
  /** 0-1 progress value */
  progress: number;
  /** Bytes downloaded */
  loadedBytes: number;
  /** Total bytes (0 if unknown) */
  totalBytes: number;
  /** Download speed in bytes/sec */
  speedBps: number;
  /** Currently downloading file name (e.g. "encoder.onnx") */
  currentFile?: string | null;
  /** Cancel callback — when provided, shows cancel (X) button */
  onCancel?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * ModelDownloadSection — Compact inline download progress for drawer panels.
 *
 * Shows:
 *   - Spinner + "Downloading..." label
 *   - Percentage + cancel button
 *   - Progress bar
 *   - Stats: loaded/total (filename) + speed
 *
 * Used by both SegmentationPanel and BgRemoverPanel for consistent UX.
 */
export const ModelDownloadSection = React.memo(function ModelDownloadSection({
  progress,
  loadedBytes,
  totalBytes,
  speedBps,
  currentFile,
  onCancel,
}: ModelDownloadSectionProps) {
  const percent = Math.min(100, Math.max(0, Math.round(progress * 100)));

  return (
    <div className="animate-in fade-in slide-in-from-top-1 duration-200 space-y-1">
      {/* Header: label + percent + cancel */}
      <div className="flex justify-between items-center">
        <span className="text-[10px] text-[var(--text-muted)] font-medium flex items-center gap-1">
          <Loader2 size={10} className="animate-spin" />
          Downloading...
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-[var(--text-secondary)]">
            {percent}%
          </span>
          {onCancel && (
            <button
              onClick={onCancel}
              className="p-0.5 rounded hover:bg-white/10 text-[var(--text-muted)] hover:text-rose-400 transition-colors"
              title="Cancel download"
            >
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 rounded-full bg-white/5 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300 bg-purple-500/80"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Stats: size + speed */}
      {totalBytes > 0 && (
        <div className="flex justify-between text-[9px] text-[var(--text-muted)]">
          <span>
            {formatBytes(loadedBytes)} / {formatBytes(totalBytes)}
            {currentFile ? ` (${currentFile})` : ''}
          </span>
          {speedBps > 0 && <span>{formatSpeed(speedBps)}</span>}
        </div>
      )}
    </div>
  );
});
