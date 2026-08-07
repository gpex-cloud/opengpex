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
import { ChevronDown } from "lucide-react";

import type { ImageMetadata } from "@opengpex/editor/core/files";

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

interface MetadataPanelProps {
  imageMetadata?: ImageMetadata;
}

export function MetadataPanel({ imageMetadata }: MetadataPanelProps) {
  const [isExifExpanded, setIsExifExpanded] = React.useState(false);

  if (!imageMetadata) return null;

  const meta = imageMetadata;

  // Skip rendering if no meaningful EXIF/metadata to display
  if (!meta.camera && !meta.capture && !meta.dates && !meta.raw?.icc) return null;

  const formatDate = (isoStr: string | undefined | null) => {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    return isNaN(d.getTime()) ? null : d.toLocaleString();
  };

  const mainCamera =
    meta.camera?.make || meta.camera?.model
      ? `${meta.camera.make || ""}${meta.camera.model ? " " + meta.camera.model : ""}`.trim()
      : null;
  const settings = [
    meta.capture?.fNumber ? `ƒ/${parseFloat(meta.capture.fNumber.toFixed(1))}` : null,
    meta.capture?.exposureTime
      ? `1/${Math.round(1 / meta.capture.exposureTime)}s`
      : null,
    meta.capture?.iso ? `ISO${meta.capture.iso}` : null,
    meta.capture?.focalLength ? `${parseFloat(meta.capture.focalLength.toFixed(2))}mm` : null,
  ]
    .filter(Boolean)
    .join(" • ");

  const hasIccProfile = !!meta.raw?.icc;

  const detailedItems = [
    // ── Capture ──
    { label: "Camera", value: mainCamera },
    {
      label: "Lens",
      value:
        meta.camera?.lensMake || meta.camera?.lensModel
          ? `${meta.camera.lensMake || ""} ${meta.camera.lensModel || ""}`.trim()
          : meta.camera?.lensModel,
    },
    {
      label: "Aperture",
      value: meta.capture?.fNumber ? `ƒ/${parseFloat(meta.capture.fNumber.toFixed(1))}` : null,
    },
    {
      label: "Shutter Speed",
      value: meta.capture?.exposureTime
        ? `1/${Math.round(1 / meta.capture.exposureTime)}s`
        : null,
    },
    {
      label: "ISO",
      value: meta.capture?.iso
        ? `ISO ${meta.capture.iso}`
        : null,
    },
    {
      label: "Focal Length",
      value: meta.capture?.focalLength ? `${parseFloat(meta.capture.focalLength.toFixed(2))}mm` : null,
    },
    { label: "White Balance", value: meta.capture?.whiteBalance },
    // ── Dates ──
    {
      label: "Original Date",
      value: formatDate(meta.dates?.created),
    },
    // ── Image Technical ──
    {
      label: "Resolution",
      value: meta.dpi
        ? `${meta.dpi} PPI`
        : null,
    },
    // ── Color ──
    {
      label: "Color Space",
      value:
        meta.colorSpace && meta.colorSpace !== 'srgb' && meta.colorSpace !== 'unknown'
          ? formatColorSpace(meta.colorSpace)
          : meta.colorSpace === 'srgb'
            ? "sRGB"
            : null,
    },
    {
      label: "ICC Profile",
      value: hasIccProfile
        ? (meta.raw.icc!.name || "Embedded")
        : null,
    },
    // ── Meta ──
    { label: "Software", value: meta.camera?.software },
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
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
                Exif Information
              </span>
              {hasIccProfile && (
                <span className="text-[7px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1 py-0.5 rounded border border-emerald-500/20 uppercase leading-none">
                  ICC
                </span>
              )}
            </div>
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
          <div className="flex flex-col gap-1.5 p-2 pt-0 border-t border-[var(--border-subtle)] dark:border-white/10 mt-1 pt-2 animate-in fade-in slide-in-from-top-1 duration-200">
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
}
