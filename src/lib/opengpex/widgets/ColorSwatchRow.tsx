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

import React, { useState } from 'react';
import { ColorPickerPro } from '@opengpex/editor/widgets/ColorPickerPro';
import Popover from '@opengpex/editor/widgets/Popover';

/**
 * ColorSwatchRow: compact color control — a small swatch + hex label that
 * opens the full ColorPickerPro inside a Popover on click.
 *
 * This replaces the always-open inline picker (which occupied ~140px of
 * vertical space per color). Mirrors the mainstream editor pattern (Figma /
 * Photoshop / this app's own ColorOptions toolbar): the panel stays dense,
 * and the heavy SV-area picker only appears on demand.
 */
const ColorSwatchRow = React.memo(function ColorSwatchRow({
  label,
  labelClassName = 'text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-20 shrink-0',
  color,
  onChange,
}: {
  label: string;
  labelClassName?: string;
  color: string;
  onChange: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-2 px-1">
      <span className={labelClassName}>{label}</span>
      <Popover
        isOpen={open}
        onClose={() => setOpen(false)}
        position="left"
        align="start"
        content={
          <div className="w-52 p-2.5">
            <ColorPickerPro
              variant="compact"
              color={color}
              onChange={onChange}
            />
          </div>
        }
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 flex-1 px-1.5 py-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-stage)] hover:border-indigo-500/40 transition-colors"
        >
          <span
            className="w-4 h-4 rounded shadow-inner ring-1 ring-black/15 dark:ring-white/20 shrink-0"
            style={{ backgroundColor: color }}
          />
          <span className="text-[10px] font-bold uppercase tabular-nums text-[var(--text-main)] tracking-tight">
            {color}
          </span>
        </button>
      </Popover>
    </div>
  );
});

export default ColorSwatchRow;
