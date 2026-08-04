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
import { Sparkles } from "lucide-react";
import FunctionTabs from "@opengpex/editor/widgets/FunctionTabs";
import { useMosaicPanel } from "../hooks";
import { MOSAIC_SIZE_PRESETS } from "../protocols";

// ─── MosaicPanel ───────────────────────────────────────────────────────────────

/**
 * MosaicPanel: Mosaic tool attributes panel
 *
 * Rendered inside CraftDrawer, displayed when activeCraft='mosaic'.
 * Provides preset size selection (S/M/L) for block size and brush diameter
 * using FunctionTabs widget.
 * Also shows a "Coming Soon" hint for AI Mosaic Tool.
 */

const PRESET_OPTIONS = (['S', 'M', 'L'] as const).map((key) => {
  const data = MOSAIC_SIZE_PRESETS[key];
  return {
    value: key,
    label: '',
    icon: (
      <span className="flex flex-col items-center gap-0.5 py-0.5">
        <span className="text-[12px] font-black">{key}</span>
        <span className="text-[9px] font-medium opacity-60">{data.blockSize}px</span>
      </span>
    ),
    tooltip: `Block: ${data.blockSize}px · Brush: ${data.brushDiameter}px`,
  };
});

export const MosaicPanel = React.memo(function MosaicPanel() {
  const { sizePreset, setSizePreset } = useMosaicPanel();

  return (
    <div className="flex flex-col gap-2 p-1">
      {/* ── Upper: Block size selection ── */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight px-1">
          Block Size
        </span>
        <FunctionTabs
          options={PRESET_OPTIONS}
          value={sizePreset}
          onChange={setSizePreset}
          size="sm"
        />
      </div>

      {/* ── Middle: Divider ── */}
      <div className="border-t border-[var(--border)] my-1" />

      {/* ── Lower: AI Mosaic Tool Coming Soon ── */}
      <div className="flex items-center gap-1.5 px-1 py-1.5 rounded-md bg-[var(--surface-alt)] opacity-60">
        <Sparkles size={12} className="text-[var(--text-muted)]" />
        <span className="text-[9px] text-[var(--text-muted)]">
          AI Mosaic Tool — Coming Soon
        </span>
      </div>
    </div>
  );
});
