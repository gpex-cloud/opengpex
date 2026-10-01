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
import FancyButton from "@opengpex/editor/widgets/FancyButton";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import * as P from "../../protocols";

interface PngStreamOptionsProps {
  config: P.ExportConfig;
  updateConfig: (cfg: Partial<P.ExportConfig>) => void;
  className?: string;
}

/** PngStreamOptions — PNG compression-level selector (none / default / max). */
export function PngStreamOptions({
  config,
  updateConfig,
  className = "",
}: PngStreamOptionsProps) {
  return (
    <div
      className={`flex justify-between items-center px-1 animate-in fade-in slide-in-from-top-1 duration-200 ${className}`}
    >
      <Tooltip content="PNG compression level (lossless). Higher compression takes longer to encode but yields smaller files.">
        <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest cursor-help">
          Compression
        </span>
      </Tooltip>
      <ActionDropdown
        direction="up"
        onSelect={(val: string) =>
          updateConfig({ pngCompression: Number(val) as 0 | 6 | 9 })
        }
        className="shrink-0"
        options={[
          { label: "None", value: "0", description: "fastest, largest" },
          { label: "Default", value: "6", description: "balanced" },
          { label: "Max", value: "9", description: "smallest, slowest" },
        ]}
        trigger={
          <FancyButton variant="zinc" subtle={true} size="xs">
            {config.pngCompression === 0
              ? "NONE"
              : config.pngCompression === 9
                ? "MAX"
                : "DEFAULT"}{" "}
            <ChevronDown size={8} className="opacity-50 ml-0.5" />
          </FancyButton>
        }
      />
    </div>
  );
}
