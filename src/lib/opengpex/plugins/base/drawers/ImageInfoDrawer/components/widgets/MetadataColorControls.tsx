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
import Switch from "@opengpex/editor/widgets/Switch";
import type { GamutOption } from "../../hooks";

interface MetadataColorControlsProps {
  showExif: boolean;
  keepExif: boolean;
  onKeepExifChange: (val: boolean) => void;

  showIcc: boolean;
  embedIcc: boolean;
  onEmbedIccChange: (val: boolean) => void;

  showColorSpace: boolean;
  gamutOptions: GamutOption[];
  currentGamutLabel: string;
  isSourceGamut: boolean;
  isAdapted?: boolean;
  adaptedReason?: string;
  gamutTooltip?: string;
  canReset?: boolean;
  onGamutSelect: (val: string) => void;
  onGamutReset: () => void;
}

const CAPTION_CLASS =
  "text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest";

/**
 * MetadataColorControls — Metadata & color output section: Keep EXIF, Embed ICC
 * Profile, and the format-filtered Color Space selector. Renders nothing when
 * the active format exposes none of them.
 */
export function MetadataColorControls({
  showExif,
  keepExif,
  onKeepExifChange,
  showIcc,
  embedIcc,
  onEmbedIccChange,
  showColorSpace,
  gamutOptions,
  currentGamutLabel,
  isSourceGamut,
  isAdapted = false,
  adaptedReason,
  gamutTooltip,
  canReset = !isSourceGamut,
  onGamutSelect,
  onGamutReset,
}: MetadataColorControlsProps) {
  if (!showExif && !showIcc && !showColorSpace) return null;

  const tooltipText =
    gamutTooltip ||
    (isAdapted && adaptedReason ? adaptedReason : undefined) ||
    "Output color profile. Formats without raw-16 support automatically restrict options to canvas-supported gamuts.";

  return (
    <div className="space-y-1.5 pt-1.5 animate-in fade-in slide-in-from-top-1 duration-200 border-t border-[var(--border-subtle)]/60 dark:border-white/5">
      {/* Embed ICC Profile */}
      {showIcc && (
        <div className="flex justify-between items-center px-1">
          <Tooltip content="Embed ICC color profile in exported container for strict cross-application color matching">
            <span className={`${CAPTION_CLASS} cursor-help`}>Embed ICC Profile</span>
          </Tooltip>
          <Switch
            checked={embedIcc}
            onChange={onEmbedIccChange}
            activeColor="bg-indigo-500"
            size="compact"
          />
        </div>
      )}

      {/* Keep EXIF Data */}
      {showExif && (
        <div className="flex justify-between items-center px-1">
          <Tooltip content="Preserve camera EXIF metadata in exported container">
            <span className={`${CAPTION_CLASS} cursor-help`}>Keep EXIF Data</span>
          </Tooltip>
          <Switch
            checked={keepExif}
            onChange={onKeepExifChange}
            activeColor="bg-emerald-500"
            size="compact"
          />
        </div>
      )}

      {/* Color Space (only when format supports multiple gamuts) */}
      {showColorSpace && (
        <div className="flex justify-between items-center px-1 animate-in fade-in duration-200">
          <Tooltip
            maxWidth="260px"
            uppercase={false}
            content={tooltipText}
          >
            <span
              className={`${CAPTION_CLASS} cursor-help ${
                !isSourceGamut ? "text-amber-600 dark:text-amber-400" : ""
              }`}
            >
              Color Space
            </span>
          </Tooltip>
          <div className="flex items-center gap-1 shrink-0">
            <ActionDropdown
              direction="up"
              onSelect={onGamutSelect}
              className="shrink-0"
              options={gamutOptions}
              trigger={
                <Tooltip
                  maxWidth="260px"
                  uppercase={false}
                  content={tooltipText}
                >
                  <FancyButton variant={isSourceGamut ? "green" : "amber"} subtle={true} size="xs">
                    {currentGamutLabel}{" "}
                    <ChevronDown size={8} className="opacity-50 ml-0.5" />
                  </FancyButton>
                </Tooltip>
              }
            />
            <Tooltip content={isAdapted ? "Reset to Default" : "Reset to Original"}>
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
      )}
    </div>
  );
}
