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

interface LayerDimensionsPanelProps {
  isClipMode: boolean;
  baseW: number;
  baseH: number;
  hoveredLayerId?: string | null;
  layerDim: { w: number; h: number };
  isHighRes: boolean;
  isUpScaled: boolean;
}

export function LayerDimensionsPanel({
  isClipMode,
  baseW,
  baseH,
  hoveredLayerId,
  layerDim,
  isHighRes,
  isUpScaled,
}: LayerDimensionsPanelProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="flex flex-col bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] ">
        <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight mb-1">
          {isClipMode ? "Selection" : "Canvas"}
        </span>
        <span className="text-[10px] font-bold text-[var(--text-main)] tabular-nums uppercase">
          {baseW} × {baseH}
        </span>
      </div>
      <div className="flex flex-col bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] ">
        <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight mb-1">
          {hoveredLayerId ? "Hovered Layer" : "Active Layer"}
        </span>
        <span
          className={`text-[10px] font-bold tabular-nums uppercase ${isHighRes ? "text-emerald-500" : isUpScaled ? "text-rose-500" : "text-[var(--text-main)]"}`}
        >
          {Math.round(layerDim.w)} × {Math.round(layerDim.h)}
        </span>
      </div>
    </div>
  );
}
