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

/**
 * InferencePanel — Shared task progress card for all AI tool drawer panels.
 *
 * Renders:
 *   - Spinner or checkmark icon + message text
 *   - Optional right-side detail text (auto-generates percentage if not provided)
 *   - Progress bar (determinate or indeterminate pulse)
 *   - Optional Cancel button
 *
 * Variants:
 *   - 'default': Purple progress bar with spinner (in-progress)
 *   - 'success': Green progress bar with checkmark (complete)
 *
 * @see docs/opengpex/plans/20260810_progress_panel_spec.md
 */

import React from 'react';
import { Loader2, CheckCircle2, X } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InferencePanelProps {
  /** 当前阶段描述文字 (e.g. "Loading model...", "Processing...", "Tile 3/8") */
  message: string;
  /** 0-1 进度值；null/undefined 时为 indeterminate（pulse 动画） */
  progress?: number | null;
  /** 右侧补充文字（如 "45%", "3/8"）；不传则自动从 progress 生成百分比 */
  detail?: string;
  /** 进度条颜色变体 */
  variant?: 'default' | 'success';
  /** 取消按钮回调，不传则不显示 Cancel */
  onCancel?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export const InferencePanel = React.memo(function InferencePanel({
  message,
  progress,
  detail,
  variant = 'default',
  onCancel,
}: InferencePanelProps) {
  const isIndeterminate = progress == null;
  const percent = isIndeterminate ? 15 : Math.min(100, Math.max(0, Math.round(progress * 100)));
  const autoDetail = detail ?? (isIndeterminate ? '' : `${percent}%`);
  const isSuccess = variant === 'success';

  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-stage)] px-2.5 py-2 space-y-1.5">
      {/* Header: icon + message + detail */}
      <div className="flex justify-between items-center">
        <span className="text-[10px] text-[var(--text-muted)] font-medium flex items-center gap-1">
          {isSuccess
            ? <CheckCircle2 size={10} className="text-emerald-400" />
            : <Loader2 size={10} className="animate-spin" />
          }
          {message}
        </span>
        {autoDetail && (
          <span className="text-[10px] text-[var(--text-muted)]">
            {autoDetail}
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-1 rounded-full bg-[var(--bg-panel)] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            isSuccess ? 'bg-emerald-500/80' : 'bg-purple-500/80'
          } ${isIndeterminate ? 'animate-pulse' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Cancel button */}
      {onCancel && !isSuccess && (
        <button
          onClick={onCancel}
          className="flex items-center gap-1 mt-0.5 text-[9px] text-rose-400/80 hover:text-rose-300 transition-colors"
        >
          <X size={9} />
          Cancel
        </button>
      )}
    </div>
  );
});
