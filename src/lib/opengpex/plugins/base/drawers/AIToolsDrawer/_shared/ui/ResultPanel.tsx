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
 * ResultPanel — Shell-style result card for all AI tool drawer panels.
 *
 * Provides a consistent container with:
 *   - Header: title (uppercase) + elapsed time
 *   - Children slot: tool-specific result content
 *   - Footer: Clear button
 *
 * Each tool fills in its own content via `children`.
 * This ensures visual framework consistency (border, title, Clear button position)
 * while allowing full flexibility for tool-specific result displays.
 *
 */

import React from 'react';
import { Trash2 } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResultPanelProps {
  /** Header 标题（默认 "Result"） */
  title?: string;
  /** 右侧耗时文字（如 "1.2s"） */
  elapsed?: string;
  /** Clear 回调 — 渲染 footer Clear 按钮 */
  onClear: () => void;
  /** 工具特定的结果内容（完全自由） */
  children: React.ReactNode;
}

// ─── Component ───────────────────────────────────────────────────────────────

export const ResultPanel = React.memo(function ResultPanel({
  title = 'Result',
  elapsed,
  onClear,
  children,
}: ResultPanelProps) {
  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-stage)] px-2.5 py-2 space-y-1.5">
      {/* Header */}
      <div className="flex justify-between items-center">
        <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider">
          {title}
        </span>
        {elapsed && (
          <span className="text-[9px] text-[var(--text-muted)]">
            {elapsed}
          </span>
        )}
      </div>

      {/* Tool-specific content */}
      {children}

      {/* Footer: Clear */}
      <div className="flex justify-end">
        <button
          onClick={onClear}
          className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text-main)] flex items-center gap-0.5"
        >
          <Trash2 size={8} />
          Clear
        </button>
      </div>
    </div>
  );
});
