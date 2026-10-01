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

export interface ChannelInputChannel {
  key: string;
  label: string;
  value: string | number;
  suffix?: string;
  /** Dims the value alongside the label (e.g. a trailing alpha channel). */
  muted?: boolean;
}

interface ChannelInputProps {
  channels: ChannelInputChannel[];
  /** true = plain-text readout; false = inline-editable inputs. */
  readOnly: boolean;
  onChannelChange?: (key: string, value: string) => void;
  onCommit?: () => void;
  title?: string;
  className?: string;
}

/**
 * Single dense rounded box holding several labelled channel values
 * (`R: 0.9175 G: 0.2003 B: 0.1386`-style). One visual style, two interaction
 * modes via `readOnly` — used both for read-only wide-gamut readouts and for
 * editable RGB/HSL rows.
 */
export default function ChannelInput({
  channels,
  readOnly,
  onChannelChange,
  onCommit,
  title,
  className = '',
}: ChannelInputProps) {
  return (
    <div
      className={`flex-1 flex items-center justify-between bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg px-2.5 h-6 text-[10px] font-mono tabular-nums text-zinc-700 dark:text-zinc-300 overflow-hidden focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/20 transition-all ${className}`}
      title={title}
    >
      {channels.map((c) => (
        <span key={c.key} className="flex items-center gap-0.5 min-w-0">
          <span className="text-[9px] font-bold text-zinc-400 select-none shrink-0">
            {c.label}
          </span>
          {readOnly ? (
            <span className={c.muted ? 'truncate text-zinc-400' : 'truncate'}>
              {c.value}
            </span>
          ) : (
            <input
              type="text"
              value={c.value}
              onChange={(e) => onChannelChange?.(c.key, e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={onCommit}
              size={Math.max(1, String(c.value).length)}
              className="bg-transparent outline-none font-mono font-bold tabular-nums text-zinc-700 dark:text-zinc-300 min-w-0"
            />
          )}
          {c.suffix && (
            <span className="text-[9px] font-bold text-zinc-400 select-none shrink-0">
              {c.suffix}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
