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
} from "lucide-react";
import FancyButton from "@opengpex/editor/widgets/FancyButton";
import ComboInput from "@opengpex/editor/widgets/ComboInput";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import Tooltip from "@opengpex/editor/widgets/Tooltip";

import { ExifData, CommandInstance } from "@opengpex/editor/core/types";
import { formatPrintSize, DPI_PRESETS } from "@opengpex/editor/core/files";
import * as P from "../protocols";
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
  exif?: ExifData;
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
  exif,
}: ResizeExportControlsProps) {
  // Effective DPI: pending override in config, or frame's committed value
  const effectiveDpi = config.dpi || frameDpi;
  const [isProcessing, setIsProcessing] = React.useState(false);

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
    const format =
      val === "PNG"
        ? "image/png"
        : val === "JPG"
          ? "image/jpeg"
          : val === "AVIF"
            ? "image/avif"
            : val === "TIFF"
              ? "image/tiff"
              : "image/webp";
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
    <div className="mt-2 pt-3 border-t border-[var(--border-subtle)] space-y-3">
      <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-2 block">
        Resize & Export
      </span>
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
                active={config.lockAspect}
                variant={config.lockAspect ? "indigo" : "red"}
                subtle={true}
                disabled={isClipMode}
                size="xs"
                iconOnly={true}
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
              active={config.resample}
              variant={config.resample ? "amber" : "zinc"}
              subtle={true}
              size="xs"
              iconOnly={true}
              disabled={isClipMode}
            >
              <Link2 size={10} className={config.resample ? "text-amber-500" : ""} />
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

      <div className="border-t border-[var(--border-subtle)] space-y-2.5">
        {config.format === "image/tiff" && (
          <div className="flex items-center gap-2 px-1 mt-3 animate-in fade-in slide-in-from-top-1 duration-300">
            <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-14">
              Compress
            </span>
            <ActionDropdown
              onSelect={(val: string) => {
                updateConfig({ tiffCompression: val as 'none' | 'lzw' | 'zip' });
              }}
              className="shrink-0"
              options={[
                { label: "None", value: "none", description: "uncompressed" },
                { label: "LZW", value: "lzw", description: "universal, fast" },
                { label: "ZIP", value: "zip", description: "smaller, slower" },
              ]}
              trigger={
                <button className="flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-stage)] text-[10px] font-black text-[var(--text-main)] tabular-nums hover:bg-[var(--border-subtle)] transition-colors uppercase">
                  {config.tiffCompression || "none"} <ChevronDown size={8} className="opacity-40" />
                </button>
              }
            />
          </div>
        )}
        {config.format !== "image/png" && config.format !== "image/tiff" && (
          <div className="flex items-center gap-2 px-1 mt-3 animate-in fade-in slide-in-from-top-1 duration-300">
            <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-8">
              Quality
            </span>
            <input
              type="range"
              min="1"
              max="100"
              value={config.quality ?? 92}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                const snapPoints = [60, 95];
                const threshold = 3;
                let finalVal = val;
                for (const p of snapPoints) {
                  if (Math.abs(val - p) <= threshold) {
                    finalVal = p;
                    break;
                  }
                }
                updateConfig({ quality: finalVal });
              }}
              style={{
                accentColor: (() => {
                  const val = config.quality ?? 92;
                  if (val === 92) return "#666666";
                  return val > 92 ? "#10b981" : "#f59e0b";
                })(),
              }}
              className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
            />
            <span
              className="text-[10px] font-black w-10 text-right tabular-nums transition-colors duration-300"
              style={{
                color: (() => {
                  const q = config.quality ?? 92;
                  const ratio = Math.min(1, Math.max(0, (q - 30) / (92 - 30)));
                  const h = 142 - ratio * (142 - 38);
                  return `hsl(${h}, 80%, 45%)`;
                })(),
              }}
            >
              {config.quality ?? 92}%
            </span>
          </div>
        )}

        {config.format === "image/jpeg" && exif && (
          <div className="flex justify-between items-center pt-1.5 pb-1 px-1 animate-in fade-in slide-in-from-top-1 duration-300">
            <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest">
              Keep EXIF Data
            </span>
            <button
              onClick={() => updateConfig({ keepExif: !config.keepExif })}
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${config.keepExif ? "bg-emerald-500" : "bg-[var(--border-subtle)] "}`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-[var(--bg-panel)] transition-transform ${config.keepExif ? "translate-x-3.5" : "translate-x-0.5"}`}
              />
            </button>
          </div>
        )}

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
              onSelect={handleFormatSelect}
              disabled={isProcessing}
              className="shrink-0"
              options={[
                {
                  label: "PNG",
                  value: "PNG",
                  description: "large, lossless",
                },
                {
                  label: "JPG",
                  value: "JPG",
                  description: "standard, lossy",
                },
                {
                  label: "WEBP",
                  value: "WEBP",
                  description: "small, modern",
                },
                {
                  label: "AVIF",
                  value: "AVIF",
                  description: "small, next-gen",
                },
                {
                  label: "TIFF",
                  value: "TIFF",
                  description: "print, lossless",
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
    </div>
  );
}
