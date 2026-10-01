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
import { ExportControlRow } from "./ExportControlRow";

interface QualitySliderProps {
  label: string;
  /** Resolved current value (caller applies its own default). */
  value: number;
  /** Fires with the (optionally snapped) integer value. */
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** Values the thumb magnetically snaps to when released nearby. */
  snapPoints?: number[];
  snapThreshold?: number;
  /** Track fill color — static string or derived from the current value. */
  accentColor: string | ((v: number) => string);
  /** Percentage badge classes (color/width live here so both flavors differ cleanly). */
  badgeClassName: string;
  /** Optional inline style for the badge (e.g. value-driven hue). */
  badgeStyle?: (v: number) => React.CSSProperties;
  labelWidthClass?: string;
  gapClass?: string;
  className?: string;
}

/**
 * QualitySlider — Range input + live percentage badge shared by the generic
 * container-quality control and the TIFF-embedded JPEG quality control. The two
 * differ only in coloring/snapping, expressed through props rather than
 * duplicated markup.
 */
export function QualitySlider({
  label,
  value,
  onChange,
  min = 1,
  max = 100,
  snapPoints,
  snapThreshold = 3,
  accentColor,
  badgeClassName,
  badgeStyle,
  labelWidthClass,
  gapClass,
  className = "",
}: QualitySliderProps) {
  const applySnap = (raw: number): number => {
    if (!snapPoints) return raw;
    for (const p of snapPoints) {
      if (Math.abs(raw - p) <= snapThreshold) return p;
    }
    return raw;
  };

  const accent = typeof accentColor === "function" ? accentColor(value) : accentColor;

  return (
    <ExportControlRow
      label={label}
      labelWidthClass={labelWidthClass}
      gapClass={gapClass}
      className={className}
    >
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(applySnap(parseInt(e.target.value)))}
        onMouseUp={(e) => e.currentTarget.blur()}
        onTouchEnd={(e) => e.currentTarget.blur()}
        style={{ accentColor: accent }}
        className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner"
      />
      <span className={badgeClassName} style={badgeStyle?.(value)}>
        {value}%
      </span>
    </ExportControlRow>
  );
}
