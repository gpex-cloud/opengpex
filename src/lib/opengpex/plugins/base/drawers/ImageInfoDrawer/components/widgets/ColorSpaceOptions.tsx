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
import { ChevronDown, RotateCcw } from "lucide-react";
import FancyButton from "@opengpex/editor/widgets/FancyButton";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import type { GamutOption } from "../../hooks";

interface ColorSpaceOptionsProps {
  gamutOptions: GamutOption[];
  currentGamutLabel: string;
  isSourceGamut: boolean;
  isAdapted?: boolean;
  adaptedReason?: string;
  gamutTooltip?: string;
  canReset?: boolean;
  onGamutSelect: (val: string) => void;
  onGamutReset: () => void;
  className?: string;
}

/**
 * ColorSpaceOptions — Color Space (Gamut) selector with quick reset to source.
 * Filtered automatically by the active format's physical gamut capabilities.
 */
export function ColorSpaceOptions({
  gamutOptions,
  currentGamutLabel,
  isSourceGamut,
  isAdapted = false,
  adaptedReason,
  gamutTooltip,
  canReset = !isSourceGamut,
  onGamutSelect,
  onGamutReset,
  className = "",
}: ColorSpaceOptionsProps) {
  const tooltipText =
    gamutTooltip ||
    (isAdapted && adaptedReason ? adaptedReason : undefined) ||
    "Output color profile. Formats without raw-16 support automatically restrict options to canvas-supported gamuts.";

  const triggerButton = (
    <FancyButton
      variant={isSourceGamut ? "green" : "amber"}
      subtle={true}
      size="xs"
      className="gap-1.5"
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          isSourceGamut
            ? "bg-emerald-600 dark:bg-emerald-400"
            : "bg-amber-600 dark:bg-amber-400"
        }`}
      />
      <span>{currentGamutLabel}</span>
      <ChevronDown size={8} className="opacity-50 ml-0.5" />
    </FancyButton>
  );

  return (
    <div
      className={`flex justify-between items-center px-1 animate-in fade-in duration-200 ${className}`}
    >
      <Tooltip
        maxWidth="260px"
        uppercase={false}
        content={tooltipText}
      >
        <span
          className={`text-[9px] font-bold uppercase tracking-widest cursor-help ${
            !isSourceGamut
              ? "text-amber-600 dark:text-amber-400"
              : "text-[var(--text-muted)]"
          }`}
        >
          Color Space
        </span>
      </Tooltip>
      <div className="flex items-center gap-1 shrink-0">
        <ActionDropdown
          direction="down"
          align="right"
          onSelect={onGamutSelect}
          className="shrink-0"
          options={gamutOptions}
          trigger={
            <Tooltip
              maxWidth="260px"
              uppercase={false}
              content={tooltipText}
            >
              {triggerButton}
            </Tooltip>
          }
        />
        <Tooltip content={!isSourceGamut ? "Reset to Original" : "Reset to Default"}>
          <FancyButton
            onClick={onGamutReset}
            disabled={!canReset}
            variant="zinc"
            subtle={true}
            size="xs"
            iconOnly={true}
          >
            <RotateCcw size={11} />
          </FancyButton>
        </Tooltip>
      </div>
    </div>
  );
}
