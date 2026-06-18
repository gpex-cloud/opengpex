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
  Download,
  Link2,
  Unlink,
  RotateCcw,
  Check,
  ChevronDown,
  Info,
  Copy,
  Zap,
  Cpu,
  ShieldCheck,
  AlertCircle,
} from "lucide-react";
import {
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import { EngineStatus } from "@opengpex/editor/core/types";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import ComboInput from "@opengpex/editor/widgets/ComboInput";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import Tooltip from "@opengpex/editor/widgets/Tooltip";

import * as P from "./protocols";
import { useImageInfoCommands } from "./hooks";
import {
  deriveResizeState,
  calculateNextPixelsByWidth,
  calculateNextPixelsByHeight,
  calculateNextPixelsByPercent,
} from "./utils";

/**
 * ImageInfoComponent: Export panel
 * Responsible for rendering zoom control, quality adjustment, and export operations
 */
export function ImageInfoComponent() {
  const { state } = useEditorState();
  const { actions } = useEditorServices();
  const {
    state: exportState,
    updateConfig,
    downloadCmd,
    applyResizeCmd,
  } = useImageInfoCommands();

  const {
    config,
    activeFrame,
    finalDims,
    fileSize,
    fileFormat,
    fileName,
    engineStatuses,
    exif,
    isClipMode,
  } = exportState;
  const { w, h } = finalDims;
  const cropBox = activeFrame?.imageCropBox;
  const baseW =
    isClipMode && cropBox ? cropBox.rect.w : activeFrame?.canvas.w || 0;
  const baseH =
    isClipMode && cropBox ? cropBox.rect.h : activeFrame?.canvas.h || 0;

  const [isProcessing, setIsProcessing] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [copiedField, setCopiedField] = React.useState<string | null>(null);
  const [isExifExpanded, setIsExifExpanded] = React.useState(false);
  const [isAiInfoExpanded, setIsAiInfoExpanded] = React.useState(false);

  React.useEffect(() => {
    actions.updateStorageStats();
  }, [actions]);

  React.useEffect(() => {
    // Reset overriding pixels when switching frames,
    // so the scale/pixels always reset to the new frame's original size (100%)
    if (activeFrame?.id) {
      updateConfig({ pixels: { w: 0, h: 0 } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFrame?.id]);

  if (!activeFrame) return null;

  const hoveredLayerId = state.interaction.hoveredLayerId;
  const targetLayerId = hoveredLayerId || activeFrame.activeLayerId;
  const targetLayer = targetLayerId
    ? activeFrame.layers.byId[targetLayerId]
    : undefined;
  const layerDim = targetLayer?.bounding || { w: 0, h: 0 };
  const isHighRes = layerDim.w * layerDim.h > baseW * baseH * 1.2;
  const isUpScaled = layerDim.w * layerDim.h < baseW * baseH * 0.8;

  const hasDimensionChange =
    Math.round(w) !== Math.round(baseW) || Math.round(h) !== Math.round(baseH);
  // Apply button is only for permanently resampling the full canvas. Disable it in Clip Mode.
  const canApply = hasDimensionChange && !isClipMode;

  const { currentW, currentH, currentPercent } = deriveResizeState(
    baseW,
    baseH,
    config.pixels,
  );

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
    updateConfig({ pixels: { w: baseW, h: baseH } });
  };

  const handleFormatSelect = async (val: string) => {
    const format =
      val === "PNG"
        ? "image/png"
        : val === "JPG"
          ? "image/jpeg"
          : val === "AVIF"
            ? "image/avif"
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
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      <div className="flex justify-between items-center mb-1 shrink-0">
        <div className="flex items-center gap-2">
          <Info size={12} className="text-indigo-400 opacity-80" />
          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
            Informations
          </span>
          {!!activeFrame?.extra?.ai_generation && (
            <span className="ml-1 text-[8px] font-bold text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded shadow-sm border border-indigo-500/20 uppercase flex items-center gap-1">
              AI Generated
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-col bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] ">
          <div className="flex justify-between items-center mb-1">
            <div className="flex items-center gap-2">
              <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
                Source File
              </span>
              <FunctionButton
                onClick={() => {
                  navigator.clipboard.writeText(fileName).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
                variant="ghost"
                className="w-5 h-5"
              >
                {copied ? (
                  <Check size={10} className="text-emerald-500" />
                ) : (
                  <Copy
                    size={10}
                    className="text-[var(--text-muted)] hover transition-colors"
                  />
                )}
              </FunctionButton>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
                {fileFormat}
              </span>
              <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
                {fileSize}
              </span>
              {exif?.XResolution && (
                <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
                  {exif.XResolution}{" "}
                  {exif.ResolutionUnit === 2
                    ? "PPI"
                    : exif.ResolutionUnit === 3
                      ? "PPCM"
                      : "DPI"}
                </span>
              )}
            </div>
          </div>
          <span
            className="text-[11px] font-black text-indigo-400 truncate tracking-tight pt-0.5 pb-1"
            title={fileName}
          >
            {fileName}
          </span>
        </div>

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

        {exif &&
          (() => {
            const formatDate = (isoStr: string | undefined | null) => {
              if (!isoStr) return null;
              const d = new Date(isoStr);
              return isNaN(d.getTime()) ? null : d.toLocaleString();
            };

            const mainCamera =
              exif.Make || exif.Model
                ? `${exif.Make || ""}${exif.Model ? " " + exif.Model : ""}`.trim()
                : null;
            const settings = [
              exif.FNumber ? `ƒ/${exif.FNumber}` : null,
              exif.ExposureTime
                ? `1/${Math.round(1 / exif.ExposureTime)}s`
                : null,
              exif.ISOSpeedRatings ? `ISO${exif.ISOSpeedRatings}` : null,
              exif.FocalLength ? `${exif.FocalLength}mm` : null,
            ]
              .filter(Boolean)
              .join(" • ");

            const detailedItems = [
              { label: "Camera", value: mainCamera },
              {
                label: "Lens",
                value:
                  exif.LensMake || exif.LensModel
                    ? `${exif.LensMake || ""} ${exif.LensModel || ""}`.trim()
                    : exif.LensModel,
              },
              {
                label: "Aperture",
                value: exif.FNumber ? `ƒ/${exif.FNumber}` : null,
              },
              {
                label: "Shutter Speed",
                value: exif.ExposureTime
                  ? `1/${Math.round(1 / exif.ExposureTime)}s`
                  : null,
              },
              {
                label: "ISO",
                value: exif.ISOSpeedRatings
                  ? `ISO ${exif.ISOSpeedRatings}`
                  : null,
              },
              {
                label: "Focal Length",
                value: exif.FocalLength ? `${exif.FocalLength}mm` : null,
              },
              {
                label: "Original Date",
                value: formatDate(exif.DateTimeOriginal),
              },
              {
                label: "Digitized Date",
                value: formatDate(exif.DateTimeDigitized),
              },
              { label: "White Balance", value: exif.WhiteBalance },
              {
                label: "Color Space",
                value:
                  exif.ColorSpace === 1
                    ? "sRGB"
                    : exif.ColorSpace === 65535
                      ? "Uncalibrated"
                      : exif.ColorSpace,
              },
              {
                label: "Resolution",
                value: exif.XResolution
                  ? `${exif.XResolution} ${exif.ResolutionUnit === 2 ? "PPI" : exif.ResolutionUnit === 3 ? "PPCM" : "DPI"}`
                  : null,
              },
              { label: "Exif Version", value: exif.ExifVersion },
              { label: "Software", value: exif.Software },
            ].filter((item) => !!item.value);

            if (detailedItems.length === 0) return null;
            return (
              <div>
                <div className="flex flex-col bg-[var(--bg-stage)] rounded-xl border border-[var(--border-subtle)] overflow-hidden transition-all duration-300">
                  {/* Summary Header */}
                  <button
                    onClick={() => setIsExifExpanded(!isExifExpanded)}
                    className="w-full flex items-center justify-between p-2 hover:bg-[var(--bg-stage)] transition-colors text-left select-none"
                  >
                    <div className="flex flex-col pr-2 overflow-hidden">
                      <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight mb-1">
                        Exif Information
                      </span>
                      <span className="text-[10px] font-black text-[var(--text-main)] truncate">
                        {settings || "No exposure data"}
                      </span>
                      <span className="text-[8px] font-bold text-[var(--text-muted)] truncate mt-0.5">
                        {mainCamera || "Unknown Camera"}
                      </span>
                    </div>
                    <ChevronDown
                      size={14}
                      className={`text-[var(--text-muted)] shrink-0 transition-transform duration-300 ${isExifExpanded ? "rotate-180" : ""}`}
                    />
                  </button>

                  {/* Expanded Details */}
                  {isExifExpanded && (
                    <div className="flex flex-col gap-1.5 p-2 pt-0 border-t border-[var(--border-subtle)] mt-1 pt-2 animate-in fade-in slide-in-from-top-1 duration-200">
                      {detailedItems.map((item, i) => (
                        <div
                          key={i}
                          className="flex justify-between items-baseline gap-2"
                        >
                          <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase tracking-wider shrink-0">
                            {item.label}
                          </span>
                          <span className="text-[9px] font-semibold text-[var(--text-main)] text-right break-words">
                            {String(item.value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

        {!!activeFrame?.extra?.ai_generation &&
          (() => {
            const aiProvider = String(
              activeFrame.extra.ai_provider || "Unknown Provider",
            );
            const aiPrompt = String(activeFrame.extra.ai_prompt || "");
            const aiNegativePrompt = activeFrame.extra.ai_negative_prompt
              ? String(activeFrame.extra.ai_negative_prompt)
              : null;
            const aiSeed =
              activeFrame.extra.ai_seed !== undefined
                ? String(activeFrame.extra.ai_seed)
                : null;

            const detailedItems = [
              { label: "Prompt", value: aiPrompt },
              { label: "Negative Prompt", value: aiNegativePrompt },
              { label: "Seed", value: aiSeed },
            ].filter((item) => !!item.value);

            return (
              <div>
                <div className="flex flex-col bg-indigo-500/5 rounded-xl border border-indigo-500/20 overflow-hidden transition-all duration-300 mt-2">
                  {/* Summary Header */}
                  <button
                    onClick={() => setIsAiInfoExpanded(!isAiInfoExpanded)}
                    className="w-full flex items-center justify-between p-2 hover:bg-indigo-500/10 transition-colors text-left select-none"
                  >
                    <div className="flex flex-col pr-2 overflow-hidden">
                      <span className="text-[8px] font-black text-indigo-400 uppercase tracking-tight mb-1">
                        AI Generation Data
                      </span>
                      <span className="text-[10px] font-black text-indigo-400 truncate">
                        {aiProvider}
                      </span>
                    </div>
                    <ChevronDown
                      size={14}
                      className={`text-indigo-400 shrink-0 transition-transform duration-300 ${isAiInfoExpanded ? "rotate-180" : ""}`}
                    />
                  </button>

                  {/* Expanded Details */}
                  {isAiInfoExpanded && (
                    <div className="flex flex-col gap-1.5 p-2 pt-0 border-t border-indigo-500/20 mt-1 pt-2 animate-in fade-in slide-in-from-top-1 duration-200">
                      {detailedItems.map((item, i) => (
                        <div
                          key={i}
                          className="flex flex-col gap-1 mb-1 group relative"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[8px] font-bold text-indigo-400 uppercase tracking-wider">
                              {item.label}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                navigator.clipboard
                                  .writeText(String(item.value))
                                  .then(() => {
                                    setCopiedField(item.label);
                                    setTimeout(
                                      () => setCopiedField(null),
                                      2000,
                                    );
                                  });
                              }}
                              className="p-0.5 rounded transition-opacity focus:outline-none focus:ring-0"
                              title="Copy to clipboard"
                            >
                              {copiedField === item.label ? (
                                <Check size={10} className="text-emerald-500" />
                              ) : (
                                <Copy
                                  size={10}
                                  className="text-indigo-400 hover transition-colors"
                                />
                              )}
                            </button>
                          </div>
                          <span className="text-[9px] font-semibold text-[var(--text-main)] break-words">
                            {String(item.value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

        <div className="pt-2">
          <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-2 block">
            Imaging Engines
          </span>
          <div className="space-y-1">
            {engineStatuses.map((engine: EngineStatus) => (
              <div
                key={engine.id}
                className="flex items-center justify-between bg-[var(--bg-stage)] p-2 rounded-xl border border-[var(--border-subtle)] group/engine"
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-6 h-6 rounded-lg flex items-center justify-center ${
                      engine.status === "ready"
                        ? "bg-emerald-500/10 text-emerald-500"
                        : engine.status === "unimplemented"
                          ? "bg-[var(--bg-stage)]0/10 text-[var(--text-muted)]"
                          : "bg-rose-500/10 text-rose-500"
                    }`}
                  >
                    {engine.id.includes("wasm") ? (
                      <Zap size={12} />
                    ) : (
                      <Cpu size={12} />
                    )}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[9px] font-black text-[var(--text-main)] uppercase tracking-tighter leading-none">
                      {engine.name}
                    </span>
                    <span className="text-[7px] font-bold text-[var(--text-muted)] uppercase italic leading-tight">
                      {engine.id}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`text-[7px] font-black uppercase px-1.5 py-0.5 rounded ${
                      engine.status === "ready"
                        ? "bg-emerald-500/10 text-emerald-500"
                        : "bg-rose-500/10 text-rose-500"
                    }`}
                  >
                    {engine.status}
                  </span>
                  {engine.status === "ready" && (
                    <ShieldCheck size={10} className="text-emerald-500" />
                  )}
                  {engine.status === "error" && (
                    <AlertCircle size={10} className="text-rose-500" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

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
                  config.lockAspect
                    ? "Unlock Aspect Ratio"
                    : "Lock Aspect Ratio"
                }
              >
                <FunctionButton
                  onClick={() =>
                    updateConfig({ lockAspect: !config.lockAspect })
                  }
                  active={config.lockAspect}
                  variant="glass"
                  disabled={isClipMode}
                  className={`w-[28px] h-[28px] !rounded-lg flex items-center justify-center transition-all ${!config.lockAspect && !isClipMode ? "!text-rose-500 bg-rose-500/5 border-rose-500/20" : ""}`}
                >
                  {config.lockAspect ? (
                    <Link2 size={12} />
                  ) : (
                    <Unlink size={12} />
                  )}
                </FunctionButton>
              </Tooltip>
              <Tooltip content="Reset to Original">
                <FunctionButton
                  onClick={handleReset}
                  disabled={isClipMode || !hasDimensionChange}
                  className="w-[28px] h-[28px] !rounded-lg flex items-center justify-center"
                >
                  <RotateCcw size={12} />
                </FunctionButton>
              </Tooltip>
            </div>
          </div>

          {/* Row 2: Scale Slider */}
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
              className={`text-[10px] font-black w-10 text-right tabular-nums ${!config.lockAspect ? "text-[var(--text-muted)]" : "text-indigo-400 "}`}
            >
              {currentPercent}%
            </span>
          </div>
        </div>

        <div className="border-t border-[var(--border-subtle)] space-y-2.5">
          {config.format !== "image/png" && (
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
                    const ratio = Math.min(
                      1,
                      Math.max(0, (q - 30) / (92 - 30)),
                    );
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
            <FunctionButton
              onClick={() => applyResizeCmd?.execute()}
              disabled={!canApply}
              variant="ghost"
              className={`group w-[35%] shrink-0 h-7 text-[9px] gap-1.5 transition-all
 ${
   canApply
     ? "!bg-rose-600/10 border !border-rose-500/30 !text-rose-500 hover:!bg-rose-600 hover:!text-white hover:!border-rose-500 shadow-sm"
     : ""
 }
`}
            >
              <Check
                size={12}
                className={
                  canApply ? "text-rose-500 group-hover:text-white" : ""
                }
              />
              <span className="uppercase">Apply</span>
            </FunctionButton>

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
                ]}
                trigger={
                  <FunctionButton
                    disabled={isProcessing}
                    variant="glass"
                    className="w-16 h-7 text-[9px] gap-1 shadow-sm"
                  >
                    {(config.format || "image/png").split("/")[1].toUpperCase()}{" "}
                    <ChevronDown size={8} className="opacity-50" />
                  </FunctionButton>
                }
              />
              <FunctionButton
                onClick={onDownload}
                disabled={isProcessing}
                loading={isProcessing}
                variant="ghost"
                className={`flex-1 h-7 text-[9px] gap-1.5 !text-white transition-all shadow-sm
 ${
   exportState.isClipMode
     ? "!bg-amber-600 hover:!bg-amber-500 border !border-amber-400/20"
     : "!bg-green-600 hover:!bg-green-500 border !border-green-400/20"
 }
`}
              >
                {!isProcessing && (
                  <Download size={12} className="text-white/80" />
                )}
                <span className="uppercase">
                  {isProcessing
                    ? "Processing..."
                    : exportState.isClipMode
                      ? "Save Clip"
                      : "Save"}
                </span>
              </FunctionButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
