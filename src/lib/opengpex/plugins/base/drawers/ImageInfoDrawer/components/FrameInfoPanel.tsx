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
import { Check, ChevronDown, Copy } from "lucide-react";
import ActionButton from "@opengpex/editor/widgets/ActionButton";

import type { ImageMetadata } from "@opengpex/editor/core/files";
import { hasDisplayableMetadata, isComfyUiWorkflow } from "@opengpex/editor/core/files";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Format colorSpace slug into human-readable label */
function formatColorSpace(cs: string): string {
  const map: Record<string, string> = {
    'srgb': 'sRGB',
    'adobe-rgb': 'Adobe RGB (1998)',
    'display-p3': 'Display P3',
    'prophoto-rgb': 'ProPhoto RGB',
    'cmyk': 'CMYK',
    'grayscale': 'Grayscale',
  };
  return map[cs] || cs;
}

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
  /** Image metadata (EXIF, ICC, color space etc.) */
  imageMetadata?: ImageMetadata;
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
  imageMetadata,
}: FrameInfoPanelProps) {
  const [copied, setCopied] = React.useState(false);
  const [isMetaExpanded, setIsMetaExpanded] = React.useState(false);

  // ── Metadata computation ──
  const meta = imageMetadata;

  const hasHighBitDepth = (meta?.bitDepth ?? 8) > 8;
  const showMetadata = hasDisplayableMetadata(meta);
  const comfyWorkflowJson = isComfyUiWorkflow(meta);

  const hasIccProfile = !!meta?.raw?.icc;

  const mainCamera = meta?.camera?.make || meta?.camera?.model
    ? `${meta.camera.make || ""}${meta.camera.model ? " " + meta.camera.model : ""}`.trim()
    : null;

  const settings = [
    meta?.capture?.fNumber ? `ƒ/${parseFloat(meta.capture.fNumber.toFixed(1))}` : null,
    meta?.capture?.exposureTime
      ? `1/${Math.round(1 / meta.capture.exposureTime)}s`
      : null,
    meta?.capture?.iso ? `ISO${meta.capture.iso}` : null,
    meta?.capture?.focalLength ? `${parseFloat(meta.capture.focalLength.toFixed(2))}mm` : null,
  ].filter(Boolean).join(" • ");

  const formatDate = (isoStr: string | undefined | null) => {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    return isNaN(d.getTime()) ? null : d.toLocaleString();
  };

  const detailedItems = showMetadata ? [
    { label: "Camera", value: mainCamera },
    {
      label: "Lens",
      value: meta?.camera?.lensMake || meta?.camera?.lensModel
        ? `${meta.camera.lensMake || ""} ${meta.camera.lensModel || ""}`.trim()
        : meta?.camera?.lensModel,
    },
    {
      label: "Aperture",
      value: meta?.capture?.fNumber ? `ƒ/${parseFloat(meta.capture.fNumber.toFixed(1))}` : null,
    },
    {
      label: "Shutter Speed",
      value: meta?.capture?.exposureTime
        ? `1/${Math.round(1 / meta.capture.exposureTime)}s`
        : null,
    },
    {
      label: "ISO",
      value: meta?.capture?.iso ? `ISO ${meta.capture.iso}` : null,
    },
    {
      label: "Focal Length",
      value: meta?.capture?.focalLength ? `${parseFloat(meta.capture.focalLength.toFixed(2))}mm` : null,
    },
    { label: "White Balance", value: meta?.capture?.whiteBalance },
    {
      label: "Original Date",
      value: formatDate(meta?.dates?.created),
    },
    {
      label: "Color Space",
      value: meta?.colorSpace && meta.colorSpace !== 'srgb' && meta.colorSpace !== 'unknown'
        ? formatColorSpace(meta.colorSpace)
        : meta?.colorSpace === 'srgb' ? "sRGB" : null,
    },
    {
      label: "ICC Profile",
      value: hasIccProfile ? (meta!.raw.icc!.name || "Embedded") : null,
    },
    { label: "Software", value: meta?.camera?.software },
    ...(comfyWorkflowJson ? [{ label: "Produced by", value: "__comfyui__" }] : []),
  ].filter((item) => !!item.value) : [];

  return (
    <div className="space-y-2">
      {/* Source File Row */}
      <div className="flex flex-col bg-[var(--bg-stage)] px-2.5 pt-2 pb-[9px] rounded-xl border border-[var(--border-subtle)]">
        {/* Header: label + badges */}
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

        {/* Filename */}
        <span
          className="text-[11px] font-black text-[var(--text-main)] truncate tracking-tight pt-0.5 pb-1"
          title={fileName}
        >
          {fileName}
        </span>

        {/* Metadata section (clickable to expand) */}
        {showMetadata && detailedItems.length > 0 && (
          <>
            <button
              onClick={() => setIsMetaExpanded(!isMetaExpanded)}
              className="w-full flex items-center justify-between mt-1 pt-1.5 border-t border-[var(--border-subtle)] dark:border-white/10 hover:opacity-80 transition-opacity text-left select-none"
            >
              <div className="flex flex-col pr-2 overflow-hidden">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
                    Metadata
                  </span>
                  {hasIccProfile && (
                    <span className="text-[7px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1 py-0.5 rounded border border-emerald-500/20 uppercase leading-none">
                      ICC
                    </span>
                  )}
                  {hasHighBitDepth && (
                    <span className="text-[7px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1 py-0.5 rounded border border-emerald-500/20 uppercase leading-none">
                      {meta!.bitDepth}-bit
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-black text-[var(--text-main)] truncate">
                  {settings || "No exposure data"}
                </span>
              </div>
              <ChevronDown
                size={12}
                className={`text-[var(--text-muted)] shrink-0 transition-transform duration-300 ${isMetaExpanded ? "rotate-180" : ""}`}
              />
            </button>

            {/* Expanded metadata details */}
            {isMetaExpanded && (
              <div className="flex flex-col gap-1.5 mt-1.5 pt-1.5 border-t border-[var(--border-subtle)] dark:border-white/10 animate-in fade-in slide-in-from-top-1 duration-200">
                {detailedItems.map((item, i) => (
                  <div
                    key={i}
                    className="flex justify-between items-center gap-2"
                  >
                    <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase tracking-wider shrink-0">
                      {item.label}
                    </span>
                    {item.value === "__comfyui__" ? (
                      <span className="text-[9px] font-semibold text-[var(--text-main)]">
                        ComfyUI / <button
                          onClick={() => {
                            const blob = new Blob([comfyWorkflowJson!], { type: 'application/json' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `${fileName.replace(/\.[^.]+$/, '')}_workflow.json`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                          className="underline underline-offset-2 hover:opacity-70 transition-opacity"
                          title="Download ComfyUI workflow JSON"
                        >Get JSON</button>
                      </span>
                    ) : (
                      <span className="text-[9px] font-semibold text-[var(--text-main)] text-right break-words">
                        {String(item.value)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

      </div>

      {/* Canvas / Layer Dimensions Grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col bg-[var(--bg-stage)] px-2.5 pt-2 pb-[9px] rounded-xl border border-[var(--border-subtle)]">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
              {isClipMode ? "Selection" : "Canvas"}
            </span>
            {frameBitDepth > 8 && (
              <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
                {frameBitDepth}-bit
              </span>
            )}
          </div>
          <span className="text-[10px] font-bold text-[var(--text-main)] tabular-nums uppercase">
            {baseW} × {baseH}
          </span>
        </div>
        <div className="flex flex-col bg-[var(--bg-stage)] px-2.5 pt-2 pb-[9px] rounded-xl border border-[var(--border-subtle)]">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
              {hoveredLayerId ? "Hovered Layer" : "Active Layer"}
            </span>
            {layerBitDepth != null && layerBitDepth > 8 && (
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
