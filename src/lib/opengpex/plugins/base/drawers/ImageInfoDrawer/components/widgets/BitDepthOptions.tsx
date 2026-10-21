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
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import FunctionTabs from "@opengpex/editor/widgets/FunctionTabs";

interface BitDepthOptionsProps {
  /** Current effective export bit depth (source-derived when unset). */
  value: 8 | 16;
  /** Whether `value` equals the document's own stored depth (green) or deviates from it (amber). */
  isSourceBitDepth: boolean;
  onChange: (next: 8 | 16) => void;
  className?: string;
}

/**
 * BitDepthOptions — an 8/16-bit segment control, orthogonal to gamut selection.
 * Rendered only for formats with a raw encode lane
 * (PNG/TIFF); its visibility gate lives in `useExportRules.showBitDepth`.
 *
 * Same colour contract as the Color Space dropdown: the active tab is green while
 * it matches the source document's depth and amber once the user deviates from
 * it (8-bit source exported at 16-bit, or a 16-bit source dropped to 8-bit). No
 * source-depth or edited-state disable — v2's RenderGraph composites edited
 * documents at 16-bit fine, so an 8-bit wide-gamut source can explicitly stay
 * 8-bit (→ raw-8) or upgrade to 16-bit.
 */
export function BitDepthOptions({
  value,
  isSourceBitDepth,
  onChange,
  className = "",
}: BitDepthOptionsProps) {
  const tooltip = isSourceBitDepth
    ? "Bit depth per channel. Matches the original document's bit depth."
    : `Bit depth per channel. Output differs from the original document: exporting at ${value}-bit.`;
  return (
    <div
      className={`flex justify-between items-center px-1 animate-in fade-in slide-in-from-top-1 duration-200 ${className}`}
    >
      <Tooltip maxWidth="260px" uppercase={false} content={tooltip}>
        <span
          className={`text-[9px] font-bold uppercase tracking-widest cursor-help ${
            isSourceBitDepth
              ? "text-[var(--text-muted)]"
              : "text-amber-600 dark:text-amber-400"
          }`}
        >
          Bit Depth
        </span>
      </Tooltip>
      <FunctionTabs
        size="sm"
        className="w-28 shrink-0"
        activeTone={isSourceBitDepth ? "green" : "amber"}
        options={[
          { label: "8-bit", value: "8" },
          { label: "16-bit", value: "16" },
        ]}
        value={value === 16 ? "16" : "8"}
        onChange={(val) => onChange(val === "16" ? 16 : 8)}
      />
    </div>
  );
}
