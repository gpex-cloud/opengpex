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

interface ExportControlRowProps {
  /** Left-hand caption (e.g. "Compress", "Quality"). */
  label: string;
  /** Tailwind width class for the caption cell. Defaults to `w-14`. */
  labelWidthClass?: string;
  /** Tailwind gap class between caption and control. Defaults to `gap-2.5`. */
  gapClass?: string;
  /** Extra classes appended to the flex row (spacing / entrance animation). */
  className?: string;
  children: React.ReactNode;
}

/**
 * ExportControlRow — Shared label + control layout used by every stream-option
 * row in the export panel. Consolidates the repeated caption typography and
 * flex scaffolding that was duplicated across the TIFF / PNG / quality blocks.
 */
export function ExportControlRow({
  label,
  labelWidthClass = "w-14",
  gapClass = "gap-2.5",
  className = "",
  children,
}: ExportControlRowProps) {
  return (
    <div className={`flex items-center ${gapClass} px-1 ${className}`}>
      <span
        className={`text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest shrink-0 ${labelWidthClass}`}
      >
        {label}
      </span>
      {children}
    </div>
  );
}
