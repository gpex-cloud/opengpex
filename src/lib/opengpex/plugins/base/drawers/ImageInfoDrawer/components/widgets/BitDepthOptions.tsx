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
  /** Current effective export bit depth (8 when unset). */
  value: 8 | 16;
  onChange: (next: 8 | 16) => void;
  className?: string;
}

/**
 * BitDepthOptions — an 8/16-bit segment control, orthogonal to gamut selection
 * (egest refactor §6.1). Rendered only for formats with a raw encode lane
 * (PNG/TIFF); its visibility gate lives in `useExportRules.showBitDepth`.
 *
 * 1:1 with `config.exportBitDepth` — no source-depth or edited-state disable
 * (v2's RenderGraph composites edited documents at 16-bit fine), so an 8-bit
 * wide-gamut source can explicitly stay 8-bit (→ raw-8) or upgrade to 16-bit.
 */
export function BitDepthOptions({
  value,
  onChange,
  className = "",
}: BitDepthOptionsProps) {
  return (
    <div
      className={`flex justify-between items-center px-1 animate-in fade-in slide-in-from-top-1 duration-200 ${className}`}
    >
      <Tooltip content="Bit depth per channel. 16-bit preserves wide gamut fidelity and dynamic range for raw-capable formats (PNG/TIFF).">
        <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest cursor-help">
          Bit Depth
        </span>
      </Tooltip>
      <FunctionTabs
        size="sm"
        className="w-28 shrink-0"
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
