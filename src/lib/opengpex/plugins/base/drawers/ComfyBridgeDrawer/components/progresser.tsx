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

import React, { useState, useEffect } from 'react';
import { Square } from 'lucide-react';
import Tooltip from '@opengpex/editor/widgets/Tooltip';
import type { ExecutionState } from '../protocols';

// ─── Execution Progress Panel ──────────────────────────────────────────────────

interface ExecutionProgressPanelProps {
  execState: ExecutionState;
  onCancel: () => void;
}

/**
 * Phase-aware execution progress panel.
 * Shows different UI for each phase:
 * - uploading: indeterminate pulse + "Uploading..."
 * - queued/loading-model: indeterminate pulse + elapsed timer
 * - inferring: determinate progress bar + step count
 * - downloading: indeterminate pulse + "Downloading..."
 *
 * Cancel note: During 'loading-model' phase, ComfyUI doesn't check for
 * interrupt signals until sampling starts. The cancel button shows a
 * "pending" state to communicate this to the user.
 */
export function ExecutionProgressPanel({ execState, onCancel }: ExecutionProgressPanelProps) {
  const { phase, progress, startedAt } = execState;
  const [cancelPending, setCancelPending] = useState(false);

  // Reset cancelPending when phase changes (adjusting state during rendering)
  const [prevPhase, setPrevPhase] = useState(phase);
  if (prevPhase !== phase) {
    setPrevPhase(phase);
    setCancelPending(false);
  }

  // Elapsed timer (updates every second)
  const [elapsed, setElapsed] = useState(0);

  // Reset elapsed when startedAt changes (adjusting state during rendering)
  const [prevStartedAt, setPrevStartedAt] = useState(startedAt);
  if (prevStartedAt !== startedAt) {
    setPrevStartedAt(startedAt);
    setElapsed(0);
  }

  // Subscribe to interval for ticking elapsed
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const elapsedStr = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : `${elapsed}s`;

  const handleCancel = () => {
    setCancelPending(true);
    onCancel();
  };

  // After 3 minutes in loading-model, show cold start hint
  const COLD_START_HINT_SECONDS = 180;
  const showColdStartHint = phase === 'loading-model' && !cancelPending && elapsed >= COLD_START_HINT_SECONDS;

  // Phase label + color
  const loadingModelLabel = cancelPending
    ? 'Cancelling...'
    : showColdStartHint
      ? 'Still loading — possibly cold start...'
      : 'Loading model...';

  const phaseInfo = {
    uploading: { label: 'Uploading input...', color: 'text-sky-400' },
    queued: { label: 'Queued...', color: 'text-yellow-600' },
    'loading-model': { label: loadingModelLabel, color: cancelPending ? 'text-rose-500' : 'text-amber-500' },
    inferring: { label: cancelPending ? 'Cancelling...' : (progress ? `Step ${progress.value}/${progress.max}` : 'Generating...'), color: cancelPending ? 'text-rose-500' : 'text-emerald-600' },
    downloading: { label: 'Downloading result...', color: 'text-sky-400' },
    idle: { label: '', color: '' },
  }[phase];

  const progressPct = progress ? Math.round((progress.value / progress.max) * 100) : 0;
  const isDeterminate = phase === 'inferring' && progress && !cancelPending;

  return (
    <div className={`flex flex-col gap-1.5 px-1 py-1.5 rounded-xl bg-[var(--bg-stage)] border ${cancelPending ? 'border-rose-500/30' : 'border-[var(--border-subtle)]'}`}>
      {/* Top row: phase label + elapsed + cancel */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5">
          <span className={`text-[9px] font-black ${phaseInfo.color}`}>
            {phaseInfo.label}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-bold text-[var(--text-muted)] tabular-nums">
            {elapsedStr}
          </span>
          <Tooltip content={cancelPending ? 'Cancel sent — waiting for ComfyUI' : 'Cancel execution'} position="bottom">
            <button
              onClick={handleCancel}
              disabled={cancelPending}
              className={`flex items-center justify-center w-4 h-4 rounded transition-colors focus:outline-none ${
                cancelPending
                  ? 'text-rose-500 animate-pulse cursor-not-allowed'
                  : 'text-[var(--text-muted)] hover:text-rose-500 hover:bg-rose-500/10'
              }`}
            >
              <Square size={8} fill="currentColor" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full h-1.5 bg-[var(--bg-panel)] rounded-full overflow-hidden border border-[var(--border-subtle)]">
        {isDeterminate ? (
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        ) : cancelPending ? (
          <div className="h-full bg-rose-500/60 rounded-full animate-pulse" style={{ width: '100%' }} />
        ) : (
          <div className="h-full bg-emerald-500/60 rounded-full animate-pulse" style={{ width: '100%' }} />
        )}
      </div>
    </div>
  );
}
