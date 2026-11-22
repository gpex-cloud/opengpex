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
import FunctionTabs from "@opengpex/editor/widgets/FunctionTabs";
import { useMosaicPanel } from "../hooks";
import { MOSAIC_SIZE_PRESETS } from "../protocols";

// ─── MosaicPanel ───────────────────────────────────────────────────────────────

/**
 * MosaicPanel: Mosaic tool attributes panel
 *
 * Rendered inside CraftDrawer, displayed when activeCraft='mosaic'.
 * Top: variant switch (Mosaic pixelation vs Spot Heal). Below: shared
 * XS-XL preset tabs — block size for mosaic, stamp diameter for heal.
 */

const MODE_OPTIONS = [
  { value: 'mosaic', label: 'Mosaic' },
  { value: 'heal', label: 'Heal' },
] as const;

const PRESET_OPTIONS = (['XS', 'S', 'M', 'L', 'XL'] as const).map((key) => {
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
  const { sizePreset, setSizePreset, toolMode, setToolMode } = useMosaicPanel();

  const isHeal = toolMode === 'heal';

  return (
    <div className="flex flex-col gap-2 p-1">
      {/* ── Top: Variant switch (mosaic pixelation vs spot heal) ── */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight px-1">
          Tool
        </span>
        <FunctionTabs
          options={MODE_OPTIONS as unknown as { value: string; label: string }[]}
          value={toolMode}
          onChange={(v) => setToolMode(v as 'mosaic' | 'heal')}
          size="sm"
        />
      </div>

      {/* ── Middle: Divider ── */}
      <div className="border-t border-[var(--border-subtle)] dark:border-white/10 my-1" />

      {/* ── Lower: Size preset (block size for mosaic, stamp diameter for heal) ── */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight px-1">
          {isHeal ? 'Stamp Size' : 'Block Size'}
        </span>
        <FunctionTabs
          options={PRESET_OPTIONS}
          value={sizePreset}
          onChange={setSizePreset}
          size="sm"
        />
      </div>
    </div>
  );
});
