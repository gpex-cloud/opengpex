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

import { ExifData } from "@opengpex/editor/core/types";

interface ExifInfoPanelProps {
  exif?: ExifData;
}

export function ExifInfoPanel({ exif }: ExifInfoPanelProps) {
  const [isExifExpanded, setIsExifExpanded] = React.useState(false);

  if (!exif) return null;

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
}
