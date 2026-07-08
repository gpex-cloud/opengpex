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
import { Info } from "lucide-react";
import { useVolatileInteraction } from "@opengpex/editor/core/context";
import { getClipBox } from "@opengpex/editor/core/helpers/selection";

import { useImageInfoMetadata, useExportConfig, useClipMode } from "./hooks";
import { SourceFilePanel } from "./components/SourceFilePanel";
import { LayerDimensionsPanel } from "./components/LayerDimensionsPanel";
import { ExifInfoPanel } from "./components/ExifInfoPanel";
import { AiGenerationPanel } from "./components/AiGenerationPanel";
import { ResizeExportControls } from "./components/ResizeExportControls";

/**
 * ImageInfoComponent — Image Info, Resize & Export panel.
 *
 * Architecture:
 * - Uses 3 focused hooks instead of 1 monolithic hook to minimize re-render scope:
 *   • useImageInfoMetadata(): stable file info (changes only on frame switch)
 *   • useExportConfig(): user-adjusted export settings + command handles
 *   • useClipMode(): interaction mode flag (changes on tool switch)
 *
 * - Heavy `ResizeExportControls` is deferred via requestAnimationFrame to split
 *   the initial mount across two React scheduler ticks (eliminates message handler violation).
 *
 * - Sub-components are memoized via React.memo (see individual files) so they
 *   skip re-renders when their specific props haven't changed.
 */
export function ImageInfoComponent() {
  // --- Hooks: isolated by change frequency ---
  const meta = useImageInfoMetadata();
  const { config, updateConfig, downloadCmd, applyResizeCmd } = useExportConfig();
  const isClipMode = useClipMode();

  // [Perf] Deferred mount: render heavy ResizeExportControls after the first paint.
  const [deferredReady, setDeferredReady] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setDeferredReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Volatile (fast-track) hover state — doesn't trigger slow-track re-renders
  const hoveredLayerId = useVolatileInteraction('hoveredLayerId');

  // Reset overriding pixels when switching frames
  React.useEffect(() => {
    if (meta.activeFrame?.id) {
      updateConfig({ pixels: { w: 0, h: 0 } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.activeFrame?.id]);

  // --- Early return ---
  if (!meta.activeFrame) return null;

  const { activeFrame } = meta;

  // Compute clip/canvas dimensions (single source of truth)
  const box = getClipBox(activeFrame);
  const baseW = isClipMode && box ? box.spatial.rect.w : activeFrame.canvas.w;
  const baseH = isClipMode && box ? box.spatial.rect.h : activeFrame.canvas.h;

  // Layer dimension for the hovered or active layer
  const targetLayerId = hoveredLayerId || activeFrame.activeLayerId;
  const targetLayer = targetLayerId ? activeFrame.layers.byId[targetLayerId] : undefined;
  const layerDim = targetLayer?.visibleShape?.rect || targetLayer?.bounding || { w: 0, h: 0 };
  const isHighRes = layerDim.w * layerDim.h > baseW * baseH * 1.2;
  const isUpScaled = layerDim.w * layerDim.h < baseW * baseH * 0.8;

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      {/* Header */}
      <div className="flex justify-between items-center h-7 shrink-0">
        <div className="flex items-center gap-2">
          <Info size={12} className="text-indigo-600 dark:text-indigo-400" />
          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
            Informations
          </span>
          {!!activeFrame.extra?.ai_generation && (
            <span className="ml-1 text-[8px] font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded shadow-sm border border-indigo-500/20 uppercase flex items-center gap-1">
              AI Generated
            </span>
          )}
        </div>
      </div>

      {/* Info Panels — lightweight, render immediately */}
      <div className="space-y-2">
        <SourceFilePanel
          fileName={meta.fileName}
          fileFormat={meta.fileFormat}
          fileSize={meta.fileSize}
          dpi={meta.frameDpi}
        />

        <LayerDimensionsPanel
          isClipMode={isClipMode}
          baseW={baseW}
          baseH={baseH}
          hoveredLayerId={hoveredLayerId}
          layerDim={layerDim}
          isHighRes={isHighRes}
          isUpScaled={isUpScaled}
        />

        <ExifInfoPanel exif={meta.exif} />

        <AiGenerationPanel extra={activeFrame.extra} />
      </div>

      {/* Export Controls — deferred to next frame to avoid blocking message handler */}
      {deferredReady ? (
        <ResizeExportControls
          config={config}
          updateConfig={updateConfig}
          baseW={baseW}
          baseH={baseH}
          frameDpi={meta.frameDpi}
          isClipMode={isClipMode}
          hasSelection={!!box}
          applyResizeCmd={applyResizeCmd}
          downloadCmd={downloadCmd}
          exif={meta.exif}
          sourceBitDepth={meta.sourceBitDepth}
          isSingleLayer={meta.isSingleLayer}
        />
      ) : (
        <div className="mt-2 pt-3 border-t border-[var(--border-subtle)] h-[120px]" />
      )}
    </div>
  );
}
