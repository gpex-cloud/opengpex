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
import { Check, Copy } from "lucide-react";
import ActionButton from "@opengpex/editor/widgets/ActionButton";

// ─── Props ──────────────────────────────────────────────────────────────────

interface FrameInfoPanelProps {
  /** Source file name */
  fileName: string;
  /** Format label (e.g. "PNG", "JPEG") */
  fileFormat: string;
  /** Human-readable file size */
  fileSize: string;
  /** Document DPI */
  dpi: number;
  /** Whether clip/selection mode is active */
  isClipMode: boolean;
  /** Canvas or clip box width */
  baseW: number;
  /** Canvas or clip box height */
  baseH: number;
  /** Hovered layer id (shows "Hovered Layer" label when truthy) */
  hoveredLayerId?: string | null;
  /** Target layer dimensions */
  layerDim: { w: number; h: number };
  /** Layer is higher resolution than canvas */
  isHighRes: boolean;
  /** Layer is lower resolution than canvas */
  isUpScaled: boolean;
  /** Frame's working bit depth */
  frameBitDepth: 8 | 16 | 32;
  /** Layer's source bit depth (if available) */
  layerBitDepth?: number;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const FrameInfoPanel = React.memo(function FrameInfoPanel({
  fileName,
  fileFormat,
  fileSize,
  dpi,
  isClipMode,
  baseW,
  baseH,
  hoveredLayerId,
  layerDim,
  isHighRes,
  isUpScaled,
  frameBitDepth,
  layerBitDepth,
}: FrameInfoPanelProps) {
  const [copied, setCopied] = React.useState(false);

  return (
    <div className="space-y-2">
      {/* Source File Row */}
      <div className="flex flex-col bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] ">
        <div className="flex justify-between items-center mb-1">
          <div className="flex items-center gap-2">
            <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
              Source File
            </span>
            <ActionButton
              onClick={() => {
                navigator.clipboard.writeText(fileName).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              variant="glass"
              size="sm"
              icon={copied ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} />}
              tooltip="Copy filename"
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
              {fileFormat}
            </span>
            <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
              {dpi} DPI
            </span>
            <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
              {fileSize}
            </span>
          </div>
        </div>
        <span
          className="text-[11px] font-black text-[var(--text-main)] truncate tracking-tight pt-0.5 pb-1"
          title={fileName}
        >
          {fileName}
        </span>
      </div>

      {/* Canvas / Layer Dimensions Grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] ">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
              {isClipMode ? "Selection" : "Canvas"}
            </span>
            <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
              {frameBitDepth}-bit
            </span>
          </div>
          <span className="text-[10px] font-bold text-[var(--text-main)] tabular-nums uppercase">
            {baseW} × {baseH}
          </span>
        </div>
        <div className="flex flex-col bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] ">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
              {hoveredLayerId ? "Hovered Layer" : "Active Layer"}
            </span>
            {layerBitDepth != null && (
              <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
                {layerBitDepth}-bit
              </span>
            )}
          </div>
          <span
            className={`text-[10px] font-bold tabular-nums uppercase ${isHighRes ? "text-emerald-500" : isUpScaled ? "text-rose-500" : "text-[var(--text-main)]"}`}
          >
            {Math.round(layerDim.w)} × {Math.round(layerDim.h)}
          </span>
        </div>
      </div>
    </div>
  );
});
