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
import { useEditorServices } from "@opengpex/editor/core/context";
import { getClipBox, getClipSelectionDims } from "@opengpex/editor/core/helpers/selection";

import { useImageInfoMetadata, useExportConfig, useClipMode } from "./hooks";
import { isComfyUiWorkflow, fileCarriesHdr } from "@opengpex/editor/core/files";
import { DrawerHeader } from "@opengpex/editor/workspace/components/DrawerHeader";
import { FrameInfoPanel } from "./components/FrameInfoPanel";
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
  const { config, updateConfig, downloadCmd, downloadOriginalCmd, applyResizeCmd } = useExportConfig();
  const isClipMode = useClipMode();

  // [Perf] Deferred mount: render heavy ResizeExportControls after the first paint.
  const [deferredReady, setDeferredReady] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setDeferredReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Hover follow lives in LayerDimensionCard (inside FrameInfoPanel), the sole
  // consumer — the root deliberately does NOT subscribe to hoveredLayerId so a
  // LayersDrawer row crossing cannot re-render this whole subtree.
  const { assets, actions } = useEditorServices();

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
  // "Selection" shows the rect the user DREW: true edge lengths for a
  // rotated rectangular selection (the AABB would be fractional and
  // inflated), bounds for every other shape.
  const dims = box ? getClipSelectionDims(box) : { w: 0, h: 0, orientationDeg: 0 };
  const baseW = isClipMode && box ? dims.w : activeFrame.canvas.w;
  const baseH = isClipMode && box ? dims.h : activeFrame.canvas.h;
  const baseAngle = isClipMode && box ? dims.orientationDeg : 0;

   // Layer dimension for the hovered or active layer now computes inside
   // LayerDimensionCard (FrameInfoPanel.tsx) — the only hover consumer.

    // Per-document HDR presentation: the badge availability comes from the
    // FILE (gain map / PQ·HLG transfer); the effective state is the frame's
    // toggle, defaulting OFF — HDR is a per-document user opt-in. Toggling
    // writes `frame.hdrRender` — a render filter, never pixel data.
    const hdrAvailable = fileCarriesHdr(activeFrame.metadata);
    const hdrEnabled = activeFrame.hdrRender === true;
    const handleHdrToggle = (on: boolean) => {
      if (activeFrame.hdrRender === on) return;
      actions.updateFrame(activeFrame.id, { hdrRender: on });
    };

    // Per-document RAW style preset (the pre-grade colour step): availability
    // comes from the SOURCE ASSET's decoded RAW identity (white domain present
    // = scene-linear capture); the effective state defaults ON — the preset is
    // the out-of-box RAW look, the toggle opts OUT to the neutral baseline.
    // Toggling writes `frame.rawStyle` — a render filter, never pixel data.
    const rawStyleAvailable =
      !!activeFrame.assetId && assets.get(activeFrame.assetId)?.rawWhiteDomain !== undefined;
    const rawStyleEnabled = activeFrame.rawStyle !== false;
    const handleRawStyleToggle = (on: boolean) => {
      if (activeFrame.rawStyle !== false === on) return;
      actions.updateFrame(activeFrame.id, { rawStyle: on });
    };

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      {/* Header */}
      <DrawerHeader
        icon={<Info size={12} className="text-indigo-600 dark:text-indigo-400" />}
        title={
          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
            Informations
          </span>
        }
        leftExtras={
          (!!activeFrame.extra?.ai_generation || isComfyUiWorkflow(meta.imageMetadata)) ? (
            <span className="ml-1 text-[8px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded shadow-sm border border-amber-500/20 uppercase flex items-center gap-1">
              AI Generated
            </span>
          ) : null
        }
      />

      {/* Info Panels — lightweight, render immediately */}
      <div className="space-y-2">
        <FrameInfoPanel
          activeFrame={activeFrame}
          fileName={meta.fileName}
          fileFormat={meta.fileFormat}
          fileSize={meta.fileSize}
          dpi={meta.frameDpi}
          isClipMode={isClipMode}
          baseW={baseW}
          baseH={baseH}
          selectionAngle={baseAngle}
          imageMetadata={meta.imageMetadata}
          hdrAvailable={hdrAvailable}
          hdrEnabled={hdrEnabled}
          onHdrToggle={handleHdrToggle}
          rawStyleAvailable={rawStyleAvailable}
          rawStyleEnabled={rawStyleEnabled}
          onRawStyleToggle={handleRawStyleToggle}
        />

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
          downloadOriginalCmd={downloadOriginalCmd}
          imageMetadata={meta.imageMetadata}
          sourceBitDepth={meta.sourceBitDepth}
          isSingleLayer={meta.isSingleLayer}
        />
      ) : (
        <div className="mt-2 pt-3 border-t border-[var(--border-subtle)] dark:border-white/10 h-[120px]" />
      )}
    </div>
  );
}
