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
import {
  Link2,
  Unlink,
  RotateCcw,
  Check,
  ChevronDown,
  Download,
  ImageDown,
  Scaling,
} from "lucide-react";
import FancyButton from "@opengpex/editor/widgets/FancyButton";
import ComboInput from "@opengpex/editor/widgets/ComboInput";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import { CommandInstance } from "@opengpex/editor/core/types";
import { formatPrintSize, DPI_PRESETS, formatToMime } from "@opengpex/editor/core/files";
import type { ImageMetadata } from "@opengpex/editor/core/files";
import * as P from "../protocols";
import { ResizeExportRules } from "./ResizeExportRules";
import {
  deriveResizeState,
  calculateNextPixelsByWidth,
  calculateNextPixelsByHeight,
  calculateNextPixelsByPercent,
} from "../utils";

interface ResizeExportControlsProps {
  config: P.ExportConfig;
  updateConfig: (cfg: Partial<P.ExportConfig>) => void;
  baseW: number;
  baseH: number;
  /** Frame's committed DPI (used as fallback when config.dpi is 0) */
  frameDpi: number;
  isClipMode: boolean;
  /** Whether an active selection exists (clip box is non-null) */
  hasSelection?: boolean;
  applyResizeCmd?: CommandInstance;
  downloadCmd?: CommandInstance;
  imageMetadata?: ImageMetadata;
  /** Source image bit depth (e.g. 16 for 16-bit TIFF/PNG). Undefined = 8-bit default. */
  sourceBitDepth?: number;
  /** Whether only a single visible content layer exists (affects 16-bit tooltip: raw passthrough vs composite) */
  isSingleLayer?: boolean;
}

export function ResizeExportControls({
  config,
  updateConfig,
  baseW,
  baseH,
  frameDpi,
  isClipMode,
  hasSelection,
  applyResizeCmd,
  downloadCmd,
  imageMetadata,
  sourceBitDepth,
  isSingleLayer,
}: ResizeExportControlsProps) {
  // Effective DPI: pending override in config, or frame's committed value
  const effectiveDpi = config.dpi || frameDpi;
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);

  const { currentW, currentH, currentPercent } = deriveResizeState(
    baseW,
    baseH,
    config.pixels,
  );

  const hasDimensionChange =
    Math.round(currentW) !== Math.round(baseW) ||
    Math.round(currentH) !== Math.round(baseH);
  const hasDpiChange = config.dpi > 0 && config.dpi !== frameDpi;
  // Apply button activates when pixels or DPI changed. Disable in Clip Mode.
  const canApply = (hasDimensionChange || hasDpiChange) && !isClipMode;

  const handlePixelW = (val: number) => {
    updateConfig({
      pixels: calculateNextPixelsByWidth(
        val,
        baseW,
        baseH,
        currentH,
        config.lockAspect,
      ),
    });
  };

  const handlePixelH = (val: number) => {
    updateConfig({
      pixels: calculateNextPixelsByHeight(
        val,
        baseW,
        baseH,
        currentW,
        config.lockAspect,
      ),
    });
  };

  const handlePercentChange = (val: number) => {
    const nextPixels = calculateNextPixelsByPercent(val, baseW, baseH);
    updateConfig({ pixels: { w: nextPixels.w, h: nextPixels.h } });
  };

  const handleReset = () => {
    updateConfig({ pixels: { w: baseW, h: baseH }, dpi: 0 });
  };

  const handleFormatSelect = async (val: string) => {
    const key = val === "JPG" ? "jpeg" : val.toLowerCase();
    const format = formatToMime[key] || "image/png";
    updateConfig({ format: format as P.ExportFormat });
  };

  const onDownload = async () => {
    setIsProcessing(true);
    try {
      await downloadCmd?.execute();
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="mt-2 pt-3 border-t border-[var(--border-subtle)] dark:border-white/10 space-y-3">
      {/* Collapsible Section Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1.5 w-full pb-1 group cursor-pointer"
      >
        <ImageDown size={12} className="text-indigo-600 dark:text-indigo-400" />
        <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)] flex-1 text-left">
          Resize & Export
        </span>
        <ChevronDown
          size={12}
          className={`text-[var(--text-muted)] opacity-50 group-hover:opacity-100 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>

      {!collapsed && (<>
      {/* Resize Unified Controls */}
      <div className="flex flex-col gap-3">
        {/* Row 1: Pixel Inputs & Tools */}
        <div className="flex items-end gap-2 animate-in fade-in slide-in-from-top-1 duration-300">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-1.5">
              <ComboInput
                label="W"
                value={currentW}
                type="number"
                onChange={handlePixelW}
                disabled={isClipMode}
              />
              <span className="text-[var(--text-muted)] text-[10px]">×</span>
              <ComboInput
                label="H"
                value={currentH}
                type="number"
                onChange={handlePixelH}
                disabled={isClipMode}
              />
            </div>
          </div>
          <div className="flex gap-1 shrink-0 h-[28px]">
            <Tooltip
              content={
                config.lockAspect ? "Unlock Aspect Ratio" : "Lock Aspect Ratio"
              }
            >
              <FancyButton
                onClick={() => updateConfig({ lockAspect: !config.lockAspect })}
                variant={config.lockAspect ? "indigo" : "red"}
                subtle={true}
                disabled={isClipMode}
                size="xs"
                iconOnly={true}
                className={
                  config.lockAspect
                    ? "bg-indigo-50/70 text-indigo-600 border-indigo-200/70 hover:bg-indigo-100 hover:text-indigo-900 dark:bg-indigo-500/15 dark:text-indigo-400 dark:border-indigo-500/25 dark:hover:bg-indigo-500/25 dark:hover:text-indigo-200"
                    : "bg-rose-50/60 text-rose-500 border-rose-200/60 hover:bg-rose-100 hover:text-rose-800 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/20 dark:hover:bg-rose-500/25 dark:hover:text-rose-200"
                }
              >
                {config.lockAspect ? <Link2 size={12} /> : <Unlink size={12} />}
              </FancyButton>
            </Tooltip>
            <Tooltip content="Reset to Original">
              <FancyButton
                onClick={handleReset}
                disabled={isClipMode || (!hasDimensionChange && !hasDpiChange)}
                variant="zinc"
                subtle={true}
                size="xs"
                iconOnly={true}
              >
                <RotateCcw size={12} />
              </FancyButton>
            </Tooltip>
          </div>
        </div>

        {/* Row 2: DPI & Print Size + Resample Toggle */}
        <div className="flex items-center gap-2 px-1 mt-0.5">
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-8">
            DPI
          </span>
          <ActionDropdown
            onSelect={(val: string) => {
              const newDpi = parseInt(val, 10);
              if (newDpi <= 0 || newDpi === effectiveDpi) return;
              if (config.resample) {
                // Resample: scale pixels proportionally to maintain physical size
                const ratio = newDpi / effectiveDpi;
                const newW = Math.round(baseW * ratio);
                const newH = Math.round(baseH * ratio);
                updateConfig({ dpi: newDpi, pixels: { w: newW, h: newH } });
              } else {
                // Metadata-only: just update DPI tag (print size changes, pixels unchanged)
                updateConfig({ dpi: newDpi });
              }
            }}
            className="shrink-0"
            options={DPI_PRESETS.map((p) => ({
              label: `${p.value}`,
              value: String(p.value),
              description: p.label,
            }))}
            trigger={
              <button className="flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-stage)] text-[10px] font-black text-[var(--text-main)] tabular-nums hover:bg-[var(--border-subtle)] transition-colors">
                {effectiveDpi} <ChevronDown size={8} className="opacity-40" />
              </button>
            }
          />
          <Tooltip content={config.resample ? "Resample ON" : "Resample OFF"}>
            <FancyButton
              onClick={() => updateConfig({ resample: !config.resample })}
              variant={config.resample ? "indigo" : "zinc"}
              subtle={true}
              size="xs"
              iconOnly={true}
              disabled={isClipMode}
              className={
                config.resample
                  ? "bg-indigo-50/70 text-indigo-600 border-indigo-200/70 hover:bg-indigo-100 hover:text-indigo-900 dark:bg-indigo-500/15 dark:text-indigo-400 dark:border-indigo-500/25 dark:hover:bg-indigo-500/25 dark:hover:text-indigo-200"
                  : "bg-zinc-100/70 text-zinc-500 border-zinc-200/60 hover:bg-zinc-200/80 hover:text-zinc-900 dark:bg-zinc-800/60 dark:text-zinc-400 dark:border-zinc-700/60 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
              }
            >
              <Scaling size={12} />
            </FancyButton>
          </Tooltip>
          <span className="text-[9px] text-[var(--text-muted)] truncate flex-1 text-right">
            {formatPrintSize(Math.round(currentW), Math.round(currentH), effectiveDpi)}
          </span>
        </div>

        {/* Row 3: Scale Slider */}
        <div className="flex items-center gap-2 px-1 mt-1">
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-8">
            Scale
          </span>
          <input
            type="range"
            min="1"
            max="200"
            value={currentPercent}
            onChange={(e) => handlePercentChange(parseInt(e.target.value))}
            onMouseUp={(e) => e.currentTarget.blur()}
            onTouchEnd={(e) => e.currentTarget.blur()}
            disabled={isClipMode || !config.lockAspect}
            style={{
              accentColor: (() => {
                if (currentPercent === 100) return "#666666";
                return currentPercent > 100 ? "#10b981" : "#f59e0b";
              })(),
            }}
            className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner disabled:opacity-30 disabled:cursor-not-allowed"
          />
          <span
            className={`text-[10px] font-black w-10 text-right tabular-nums ${!config.lockAspect ? "text-[var(--text-muted)]" : "text-indigo-600 dark:text-indigo-400"}`}
          >
            {currentPercent}%
          </span>
        </div>
      </div>

      <div className="mt-2.5 pt-3 border-t border-[var(--border-subtle)] dark:border-white/10 space-y-2.5">
        <ResizeExportRules
          config={config}
          updateConfig={updateConfig}
          imageMetadata={imageMetadata}
          sourceBitDepth={sourceBitDepth}
          isSingleLayer={isSingleLayer}
        />

        <div className="flex gap-2 pt-2">
          <FancyButton
            onClick={() => applyResizeCmd?.execute()}
            disabled={!canApply}
            variant="red"
            subtle={true}
            size="xs"
            className="w-[35%]"
          >
            <Check
              size={12}
              className={canApply ? "text-rose-500 group-hover:text-white" : ""}
            />
            <span className="uppercase">Apply</span>
          </FancyButton>

          <div className="flex gap-1 flex-1">
            <ActionDropdown
              direction="up"
              onSelect={handleFormatSelect}
              disabled={isProcessing}
              className="shrink-0"
              options={[
                {
                  label: "PNG",
                  value: "PNG",
                  description: "lossless, transparency",
                },
                {
                  label: "JPG",
                  value: "JPG",
                  description: "universal, lossy",
                },
                {
                  label: "TIFF",
                  value: "TIFF",
                  description: "professional, print",
                },
                {
                  label: "WEBP",
                  value: "WEBP",
                  description: "modern web, small",
                },
                {
                  label: "AVIF",
                  value: "AVIF",
                  description: "next-gen, smallest",
                },
                {
                  label: "BMP",
                  value: "BMP",
                  description: "legacy, uncompressed",
                },
              ]}
              trigger={
                <FancyButton
                  disabled={isProcessing}
                  variant="zinc"
                  subtle={true}
                  size="xs"
                  className="w-16"
                >
                  {(config.format || "image/png").split("/")[1].toUpperCase()}{" "}
                  <ChevronDown size={8} className="opacity-50" />
                </FancyButton>
              }
            />
            <FancyButton
              onClick={onDownload}
              disabled={isProcessing || (isClipMode && !hasSelection)}
              loading={isProcessing}
              variant={isClipMode ? "amber" : "green"}
              size="xs"
              className="flex-1"
            >
              {!isProcessing && (
                <Download size={12} className="text-white/80" />
              )}
              <span className="uppercase">
                {isProcessing
                  ? "Processing..."
                  : isClipMode
                    ? "Save Clip"
                    : "Save"}
              </span>
            </FancyButton>
          </div>
        </div>
      </div>
      </>)}
    </div>
  );
}
