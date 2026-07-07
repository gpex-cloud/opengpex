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
import { useEditorServices } from "@opengpex/editor/core/context";
import { getClipBox } from "@opengpex/editor/core/helpers/selection";

import { useImageInfoCommands } from "./hooks";
import { SourceFilePanel } from "./components/SourceFilePanel";
import { LayerDimensionsPanel } from "./components/LayerDimensionsPanel";
import { ExifInfoPanel } from "./components/ExifInfoPanel";
import { AiGenerationPanel } from "./components/AiGenerationPanel";
import { ImagingEnginesPanel } from "./components/ImagingEnginesPanel";
import { ResizeExportControls } from "./components/ResizeExportControls";

/**
 * ImageInfoComponent: Export panel
 * Responsible for rendering zoom control, quality adjustment, and export operations
 */
export function ImageInfoComponent() {
  const { actions } = useEditorServices();
  const {
    state: exportState,
    updateConfig,
    downloadCmd,
    applyResizeCmd,
  } = useImageInfoCommands();

  const {
    config,
    activeFrame,
    fileSize,
    fileFormat,
    fileName,
    engineStatuses,
    exif,
    isClipMode,
  } = exportState;

  React.useEffect(() => {
    actions.updateStorageStats();
  }, [actions]);

  const hoveredLayerId = useVolatileInteraction('hoveredLayerId');

  React.useEffect(() => {
    // Reset overriding pixels when switching frames,
    // so the scale/pixels always reset to the new frame's original size (100%)
    if (activeFrame?.id) {
      updateConfig({ pixels: { w: 0, h: 0 } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFrame?.id]);

  if (!activeFrame) return null;

  const box = getClipBox(activeFrame);
  const baseW =
    isClipMode && box ? box.spatial.rect.w : activeFrame?.canvas.w || 0;
  const baseH =
    isClipMode && box ? box.spatial.rect.h : activeFrame?.canvas.h || 0;

  const targetLayerId = hoveredLayerId || activeFrame.activeLayerId;
  const targetLayer = targetLayerId
    ? activeFrame.layers.byId[targetLayerId]
    : undefined;
  const layerDim = targetLayer?.visibleShape?.rect || targetLayer?.bounding || { w: 0, h: 0 };
  const isHighRes = layerDim.w * layerDim.h > baseW * baseH * 1.2;
  const isUpScaled = layerDim.w * layerDim.h < baseW * baseH * 0.8;

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      <div className="flex justify-between items-center h-7 shrink-0">
        <div className="flex items-center gap-2">
          <Info size={12} className="text-indigo-600 dark:text-indigo-400" />
          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
            Informations
          </span>
          {!!activeFrame?.extra?.ai_generation && (
            <span className="ml-1 text-[8px] font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded shadow-sm border border-indigo-500/20 uppercase flex items-center gap-1">
              AI Generated
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <SourceFilePanel
          fileName={fileName}
          fileFormat={fileFormat}
          fileSize={fileSize}
          dpi={activeFrame.dpi || 72}
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

        <ExifInfoPanel exif={exif} />

        <AiGenerationPanel extra={activeFrame?.extra} />

        <ImagingEnginesPanel engineStatuses={engineStatuses} show={false} />
      </div>

      <ResizeExportControls
        config={config}
        updateConfig={updateConfig}
        baseW={baseW}
        baseH={baseH}
        frameDpi={activeFrame.dpi || 72}
        isClipMode={isClipMode}
        hasSelection={!!box}
        applyResizeCmd={applyResizeCmd}
        downloadCmd={downloadCmd}
        exif={exif}
        sourceBitDepth={
          ((activeFrame.layers.byId[activeFrame.layers.order[0]]?.metadata as Record<string, unknown> | undefined)
            ?.imageMetadata as { bitDepth?: number } | undefined)?.bitDepth
        }
        isSingleLayer={
          activeFrame.layers.order.filter(id => {
            const l = activeFrame.layers.byId[id];
            return !l.hostId && l.visible !== false;
          }).length === 1
        }
      />
    </div>
  );
}
