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

import type { ImageMetadata } from "@opengpex/editor/core/files";
import * as P from "../protocols";
import { useExportRules } from "../hooks";
import { QualitySlider } from "./widgets/QualitySlider";
import { TiffStreamOptions } from "./widgets/TiffStreamOptions";
import { PngStreamOptions } from "./widgets/PngStreamOptions";
import { BitDepthOptions } from "./widgets/BitDepthOptions";
import { ColorSpaceOptions } from "./widgets/ColorSpaceOptions";
import { MetadataColorControls } from "./widgets/MetadataColorControls";

interface ResizeExportRulesProps {
  config: P.ExportConfig;
  updateConfig: (cfg: Partial<P.ExportConfig>) => void;
  imageMetadata?: ImageMetadata;
  sourceBitDepth?: number;
  isSingleLayer?: boolean;
}

/**
 * ResizeExportRules — Frontend conditional display & control rules for export.
 *
 * Ordered logically by image spec hierarchy:
 * 1. Color Space & Bit Depth (fundamental pixel format & gamut)
 * 2. Compression & Quality (stream encoding parameters)
 * 3. Metadata & Profiles (Embed ICC Profile & Keep EXIF Data toggles)
 */
export function ResizeExportRules({
  config,
  updateConfig,
  imageMetadata,
  sourceBitDepth,
}: ResizeExportRulesProps) {
  const rules = useExportRules(
    config,
    updateConfig,
    imageMetadata,
    sourceBitDepth,
  );

  const showGenericQuality =
    config.format !== "image/png" &&
    config.format !== "image/tiff" &&
    config.format !== "image/bmp";

  return (
    <div className="space-y-2.5">
      {/* ─── A. Color Space & Bit Depth (Color Specification) ─── */}
      {rules.showColorSpace && (
        <ColorSpaceOptions
          gamutOptions={rules.gamutOptions}
          currentGamutLabel={rules.currentGamutLabel}
          isSourceGamut={rules.isSourceGamut}
          isAdapted={rules.isAdapted}
          gamutTooltip={rules.gamutTooltip}
          canReset={rules.canReset}
          onGamutSelect={rules.handleGamutSelect}
          onGamutReset={rules.handleGamutReset}
        />
      )}

      {rules.showBitDepth && (
        <BitDepthOptions
          value={rules.exportBitDepth}
          onChange={rules.handleBitDepthChange}
        />
      )}

      {/* ─── B. Encoding & Quality / Compression (Stream Options) ─── */}
      {showGenericQuality && (
        <QualitySlider
          label="Quality"
          value={config.quality ?? 92}
          onChange={(v) => updateConfig({ quality: v })}
          snapPoints={[60, 95]}
          labelWidthClass="w-14"
          gapClass="gap-2.5"
          className="animate-in fade-in slide-in-from-top-1 duration-200"
          accentColor={(v) =>
            v === 92 ? "#666666" : v > 92 ? "#10b981" : "#f59e0b"
          }
          badgeClassName="text-[10px] font-black w-10 text-right tabular-nums transition-colors duration-300"
          badgeStyle={(v) => {
            const ratio = Math.min(1, Math.max(0, (v - 30) / (92 - 30)));
            const h = 142 - ratio * (142 - 38);
            return { color: `hsl(${h}, 80%, 45%)` };
          }}
        />
      )}

      {config.format === "image/png" && (
        <PngStreamOptions config={config} updateConfig={updateConfig} />
      )}

      {config.format === "image/tiff" && (
        <TiffStreamOptions config={config} updateConfig={updateConfig} />
      )}

      {/* ─── C. Metadata & Profile Toggles (Embed ICC + EXIF) ─── */}
      {(rules.showIcc || rules.showExif) && (
        <MetadataColorControls
          showExif={rules.showExif}
          keepExif={!!config.keepExif}
          onKeepExifChange={(val) => updateConfig({ keepExif: val })}
          showIcc={rules.showIcc}
          embedIcc={rules.effectiveEmbedIcc}
          onEmbedIccChange={(val) => updateConfig({ embedIccOverride: val })}
          showColorSpace={false}
          gamutOptions={rules.gamutOptions}
          currentGamutLabel={rules.currentGamutLabel}
          isSourceGamut={rules.isSourceGamut}
          isAdapted={rules.isAdapted}
          gamutTooltip={rules.gamutTooltip}
          canReset={rules.canReset}
          onGamutSelect={rules.handleGamutSelect}
          onGamutReset={rules.handleGamutReset}
        />
      )}
    </div>
  );
}
