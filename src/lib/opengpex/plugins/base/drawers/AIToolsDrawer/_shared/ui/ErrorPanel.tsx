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
 * ErrorPanel — Shared error display card for all AI tool drawer panels.
 *
 * Renders:
 *   - Error message with red styling
 *   - Dismiss button
 *
 * @see docs/opengpex/plans/20260810_progress_panel_spec.md
 */

import React from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ErrorPanelProps {
  /** 错误信息 */
  message: string;
  /** 点击 Dismiss 回调 */
  onDismiss: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export const ErrorPanel = React.memo(function ErrorPanel({ message, onDismiss }: ErrorPanelProps) {
  return (
    <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 px-2.5 py-2">
      <p className="text-[10px] text-rose-400 select-text break-words">
        <span className="font-semibold">Error:</span> {message}
      </p>
      <button
        onClick={onDismiss}
        className="mt-1 text-[9px] text-rose-400/70 hover:text-rose-300 underline"
      >
        Dismiss
      </button>
    </div>
  );
});
