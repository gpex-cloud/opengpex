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
import { QualitySlider } from "./QualitySlider";

const PREDICTOR_META: Record<
  NonNullable<P.ExportConfig["tiffPredictor"]>,
  { label: string; short: string; desc: string }
> = {
  none: { label: "Predictor: None", short: "Pred: None", desc: "No prediction filter" },
  horizontal: {
    label: "Predictor: Horizontal",
    short: "Pred: Horiz",
    desc: "Best for photos and continuous tones",
  },
  float: { label: "Predictor: Float", short: "Pred: Float", desc: "Floating-point prediction" },
};

const PREDICTOR_OPTIONS = (
  Object.keys(PREDICTOR_META) as (keyof typeof PREDICTOR_META)[]
).map((key) => ({
  label: PREDICTOR_META[key].label,
  value: key,
  description: PREDICTOR_META[key].desc,
}));

interface TiffStreamOptionsProps {
  config: P.ExportConfig;
  updateConfig: (cfg: Partial<P.ExportConfig>) => void;
  className?: string;
}

/**
 * TiffStreamOptions — TIFF-specific stream controls: compression method,
 * predictor (LZW/ZIP only), and the embedded-JPEG quality slider.
 */
export function TiffStreamOptions({
  config,
  updateConfig,
  className = "",
}: TiffStreamOptionsProps) {
  const hasPredictor =
    config.tiffCompression === "lzw" || config.tiffCompression === "zip";
  const currentPredictor = config.tiffPredictor || "none";
  const predictorMeta = PREDICTOR_META[currentPredictor] ?? PREDICTOR_META.none;

  return (
    <div
      className={`space-y-2 animate-in fade-in slide-in-from-top-1 duration-200 ${className}`}
    >
      <div className="flex justify-between items-center px-1">
        <Tooltip content="TIFF container compression method. LZW and ZIP are lossless; JPEG is lossy.">
          <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest cursor-help">
            Compression
          </span>
        </Tooltip>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Predictor (LZW/ZIP only) inline before Compress */}
          {hasPredictor && (
            <div className="shrink-0 animate-in fade-in slide-in-from-right-1 duration-200">
              <ActionDropdown
                direction="up"
                onSelect={(val: string) =>
                  updateConfig({
                    tiffPredictor: val as "none" | "horizontal" | "float",
                  })
                }
                options={PREDICTOR_OPTIONS}
                trigger={
                  <FancyButton
                    variant="zinc"
                    subtle={true}
                    size="xs"
                    className="px-2 text-[9px]"
                  >
                    {predictorMeta.short}{" "}
                    <ChevronDown size={8} className="opacity-50 ml-0.5" />
                  </FancyButton>
                }
              />
            </div>
          )}

          <ActionDropdown
            direction="up"
            onSelect={(val: string) =>
              updateConfig({
                tiffCompression: val as "none" | "lzw" | "zip" | "jpeg",
              })
            }
            className="shrink-0"
            options={[
              { label: "None", value: "none", description: "uncompressed" },
              { label: "LZW", value: "lzw", description: "universal, fast" },
              { label: "ZIP", value: "zip", description: "smaller, slower" },
              { label: "JPEG", value: "jpeg", description: "lossy, smallest" },
            ]}
            trigger={
              <FancyButton variant="zinc" subtle={true} size="xs">
                {(config.tiffCompression || "none").toUpperCase()}{" "}
                <ChevronDown size={8} className="opacity-50 ml-0.5" />
              </FancyButton>
            }
          />
        </div>
      </div>

      {config.tiffCompression === "jpeg" && (
        <QualitySlider
          label="Quality"
          value={config.tiffJpegQuality ?? 85}
          onChange={(v) => updateConfig({ tiffJpegQuality: v })}
          accentColor="#6366f1"
          badgeClassName="text-[10px] font-black w-8 text-right tabular-nums text-indigo-600 dark:text-indigo-400"
          className="animate-in fade-in slide-in-from-top-1 duration-200"
        />
      )}
    </div>
  );
}
