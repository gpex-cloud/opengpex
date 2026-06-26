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

import React from "react";

/**
 * DownloadProgress — Reusable download progress bar component.
 *
 * Displays:
 *   - Title/description text
 *   - Progress bar with percentage
 *   - Downloaded / Total size
 *   - Real-time speed (MB/s)
 *   - Estimated time remaining
 *
 * Designed for general reuse: AI model downloads, WASM module loads,
 * large asset preloading, etc.
 */

export interface DownloadProgressProps {
  /** Title text displayed above the progress bar */
  title: string;
  /** Progress value 0-1 */
  progress: number;
  /** Bytes downloaded so far */
  loadedBytes: number;
  /** Total bytes to download (0 if unknown) */
  totalBytes: number;
  /** Current speed in bytes/second */
  speedBps: number;
  /** Estimated time remaining in seconds (Infinity if unknown) */
  etaSeconds: number;
  /** Optional subtitle/description */
  subtitle?: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bps: number): string {
  if (bps <= 0) return "—";
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `~${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `~${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export const DownloadProgress = React.memo(function DownloadProgress({
  title,
  progress,
  loadedBytes,
  totalBytes,
  speedBps,
  etaSeconds,
  subtitle,
}: DownloadProgressProps) {
  const percent = Math.min(100, Math.max(0, Math.round(progress * 100)));

  return (
    <div className="w-full rounded-lg border border-zinc-700/60 bg-zinc-800/80 p-3 space-y-2">
      {/* Title */}
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
        <span className="text-base">⬇️</span>
        <span>{title}</span>
      </div>

      {/* Subtitle */}
      {subtitle && (
        <p className="text-[10px] text-zinc-400 leading-tight">{subtitle}</p>
      )}

      {/* Progress bar */}
      <div className="w-full h-2 bg-zinc-700/60 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-purple-500 to-indigo-500 rounded-full transition-all duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Stats row */}
      <div className="flex items-center justify-between text-[10px] text-zinc-400">
        <span>
          {formatBytes(loadedBytes)}
          {totalBytes > 0 && ` / ${formatBytes(totalBytes)}`}
        </span>
        <span>{percent}%</span>
      </div>

      {/* Speed & ETA row */}
      <div className="flex items-center justify-between text-[10px] text-zinc-500">
        <span>{formatSpeed(speedBps)}</span>
        <span>{formatEta(etaSeconds)}</span>
      </div>
    </div>
  );
});
