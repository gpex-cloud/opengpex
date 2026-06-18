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
import {
  MousePointer2,
  Target,
  Globe,
  Layout,
  Info,
  Monitor,
  Terminal,
  RotateCw,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Layers,
  Sparkles,
  AlertCircle,
} from "lucide-react";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import { useDebugInfo } from "./hooks";
import { PopupPanel } from "@opengpex/editor/widgets/PopupPanel";

/**
 * DebugInfoComponent (Outer Controller):
 * Subscribes to debug configuration and metrics. Gets toggleCmd command handler via useDebugInfo.
 */
export const DebugInfoComponent = React.memo(function DebugInfoComponent() {
  const { metrics, toggleCmd, isEnabled } = useDebugInfo();

  if (!isEnabled || !metrics) return null;

  return (
    <DebugInfoPanel
      metrics={metrics}
      onToggle={() => toggleCmd?.execute()}
    />
  );
});

interface DebugInfoPanelProps {
  metrics: NonNullable<ReturnType<typeof useDebugInfo>['metrics']>;
  onToggle: () => void;
}

/**
 * DebugInfoPanel (Presenter):
 * Wrapped in public PopupPanel. Inherits original 310px width and 520px height limits,
 * and eliminates all hand-written Drag and Portal logic.
 */
const DebugInfoPanel = React.memo(function DebugInfoPanel({
  metrics,
  onToggle,
}: DebugInfoPanelProps) {
  const { activeLayer } = metrics;

  return (
    <PopupPanel
      isVisible={true}
      onClose={onToggle}
      size="sm"
      title="Engine Inspector"
      subTitle="Drag Header to Move"
      icon={
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
        </span>
      }
      position="BR"
      closeOnOutsideClick={false}
      className=" !h-[625px] !max-h-[625px]"
    >
      <div className="space-y-4 p-4 pr-3 text-[11px] text-[var(--text-main)] select-none">
        {/* 1. Active Target Layer Inspector */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers size={11} className="text-[var(--text-muted)]" />
              <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
                Active Layer Specs
              </span>
            </div>
            {activeLayer && (
              <span className="text-[8px] font-bold text-emerald-500 dark:text-emerald-400/80 uppercase tracking-wider bg-emerald-500/10 dark:bg-emerald-500/5 px-1.5 py-0.5 rounded">
                Selected
              </span>
            )}
          </div>

          {activeLayer ? (
            <div className="bg-gradient-to-br from-indigo-500/[0.03] to-violet-500/[0.03] dark:from-indigo-400/[0.02] dark:to-violet-400/[0.02] border border-indigo-500/15 dark:border-indigo-400/10 p-3 rounded-2xl space-y-2.5 transition-all">
              {/* Layer Title Block */}
              <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] font-black text-[var(--text-main)] truncate uppercase tracking-tight">
                    {activeLayer.name}
                  </span>
                  <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase tracking-wider mt-0.5 leading-none flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span>Type: {activeLayer.type}</span>
                    <span className="w-1 h-1 rounded-full bg-[var(--border-light)]" />
                    <span>
                      World: ({Math.round(activeLayer.world.x)},{" "}
                      {Math.round(activeLayer.world.y)})
                    </span>
                  </span>
                </div>

                {/* Visual state pills */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <div
                    className={`p-1 rounded-md ${activeLayer.visible ? "bg-indigo-500/10 text-indigo-500" : "bg-[var(--bg-panel)] text-[var(--text-muted)]"}`}
                  >
                    {activeLayer.visible ? (
                      <Eye size={10} />
                    ) : (
                      <EyeOff size={10} />
                    )}
                  </div>
                  <div
                    className={`p-1 rounded-md ${activeLayer.locked ? "bg-rose-500/10 text-rose-500" : "bg-emerald-500/10 text-emerald-500"}`}
                  >
                    {activeLayer.locked ? (
                      <Lock size={10} />
                    ) : (
                      <Unlock size={10} />
                    )}
                  </div>
                </div>
              </div>

              {/* Geometry Properties Grid */}
              <div className="grid grid-cols-2 gap-2 text-[9px] font-mono">
                <div className="p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 text-[7px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none">
                    <Globe size={8} /> Local Pos (TL)
                  </div>
                  <div className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                    X: {Math.round(activeLayer.local.x)}
                  </div>
                  <div className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                    Y: {Math.round(activeLayer.local.y)}
                  </div>
                </div>

                <div className="p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 text-[7px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none">
                    <Target size={8} /> Local Center
                  </div>
                  <div className="font-bold text-rose-600 dark:text-rose-400 tabular-nums">
                    X: {Math.round(activeLayer.physical.x)}
                  </div>
                  <div className="font-bold text-rose-600 dark:text-rose-400 tabular-nums">
                    Y: {Math.round(activeLayer.physical.y)}
                  </div>
                </div>

                <div className="p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 text-[7px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none">
                    <Layout size={8} /> Dimension
                  </div>
                  <div className="font-bold text-[var(--text-main)] tabular-nums">
                    W: {Math.round(activeLayer.width)} px
                  </div>
                  <div className="font-bold text-[var(--text-main)] tabular-nums">
                    H: {Math.round(activeLayer.height)} px
                  </div>
                </div>

                <div className="p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 text-[7px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none">
                    <RotateCw size={8} /> Pose Setup
                  </div>
                  <div className="font-bold text-indigo-600 dark:text-indigo-400 tabular-nums">
                    Rot: {Math.round(activeLayer.rotation)}°
                  </div>
                  <div className="font-bold text-indigo-600 dark:text-indigo-400 tabular-nums">
                    Opa: {Math.round(activeLayer.opacity * 100)}%
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3.5 rounded-2xl bg-[var(--bg-stage)] border border-dashed border-[var(--border-subtle)] text-[var(--text-muted)] text-center flex-col justify-center">
              <AlertCircle size={14} className="opacity-50 text-indigo-500" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-black uppercase tracking-wider text-[var(--text-muted)]">
                  No Selected Layer
                </span>
                <span className="text-[7.5px] leading-relaxed max-w-[210px] text-[var(--text-muted)]/80">
                  Select a layer on the canvas or in the Layers sidebar to
                  inspect live world coordinates and size details.
                </span>
              </div>
            </div>
          )}
        </div>

        {/* 2. Cursor Projections */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <MousePointer2 size={11} className="text-[var(--text-muted)]" />
            <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
              Cursor Tracking
            </span>
            <Tooltip
              uppercase={false}
              content={`Real-time projection of the mouse pointer across coordinate spaces:\n• World: Absolute resolution-independent units\n• Physical: Raw image pixel position relative to active frame (0,0)`}
            >
              <Info
                size={10}
                className="text-[var(--text-muted)] hover:text-indigo-500 dark:hover:text-indigo-400 cursor-help transition-colors"
              />
            </Tooltip>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[9px] font-mono">
            <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)]">
              <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1 leading-none">
                World Space
              </div>
              <div className="text-[10.5px] font-bold text-[var(--text-main)] tabular-nums">
                X: {Math.round(metrics.mouse.world.x)}
                <div className="mt-0.5">
                  Y: {Math.round(metrics.mouse.world.y)}
                </div>
              </div>
            </div>
            <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)]">
              <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1 leading-none">
                Physical Space
              </div>
              <div className="text-[10.5px] font-bold text-[var(--text-main)] tabular-nums">
                X: {Math.round(metrics.mouse.physical.x)}
                <div className="mt-0.5">
                  Y: {Math.round(metrics.mouse.physical.y)}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 3. Crop Physics */}
        {metrics.interactionMode === 'clip' && metrics.crop && metrics.crop.physical.w > 0 && (
          <div className="space-y-2 animate-in fade-in zoom-in-95 duration-300">
            <div className="flex items-center gap-2">
              <Sparkles
                size={11}
                className="text-indigo-400 dark:text-indigo-500"
              />
              <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
                Crop Physics
              </span>
              <Tooltip
                uppercase={false}
                content={`Physical properties and boundaries of the active crop marquee:\n• Screen: Actual viewport CSS pixels used for selection handles\n• Physical: Raw resolution-level dimensions for resampling`}
              >
                <Info
                  size={10}
                  className="text-[var(--text-muted)] hover:text-indigo-500 dark:hover:text-indigo-400 cursor-help transition-colors"
                />
              </Tooltip>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[9px] font-mono">
              <div className="bg-indigo-500/5 dark:bg-indigo-500/[0.02] p-2.5 rounded-xl border border-indigo-500/15 dark:border-indigo-400/10">
                <div className="text-[7px] font-black uppercase tracking-widest text-indigo-500 dark:text-indigo-400/70 mb-1 leading-none">
                  Screen (CSS px)
                </div>
                <div className="text-[10px] text-indigo-650 dark:text-indigo-300 tabular-nums font-bold">
                  {Math.round(metrics.crop.screen.x)},{" "}
                  {Math.round(metrics.crop.screen.y)}
                  <div className="text-[7.5px] opacity-60 mt-1 uppercase font-black">
                    Zoom: {metrics.scale.toFixed(2)}x
                  </div>
                </div>
              </div>
              <div className="bg-indigo-500/5 dark:bg-indigo-500/[0.02] p-2.5 rounded-xl border border-indigo-500/15 dark:border-indigo-400/10">
                <div className="text-[7px] font-black uppercase tracking-widest text-indigo-500 dark:text-indigo-400/70 mb-1 leading-none">
                  Physical (Res)
                </div>
                <div className="text-[10px] text-indigo-650 dark:text-indigo-300 tabular-nums font-bold">
                  {Math.round(metrics.crop.physical.x)},{" "}
                  {Math.round(metrics.crop.physical.y)}
                  <div className="text-[7.5px] opacity-60 mt-1 uppercase font-black">
                    {Math.round(metrics.crop.physical.w)}×
                    {Math.round(metrics.crop.physical.h)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 4. Canvas Registry & Viewport Metrics */}
        <div className="space-y-2 pt-2 border-t border-[var(--border-subtle)]">
          <div className="flex items-center gap-2">
            <Layout size={11} className="text-[var(--text-muted)]" />
            <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
              Canvas Registry
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[9px] font-mono">
            <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)]">
              <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1 leading-none">
                World Abs Origin
              </div>
              <div className="text-[10px] font-bold text-[var(--text-main)] tabular-nums">
                X: {Math.round(metrics.camera.x)}
                <div className="mt-0.5">Y: {Math.round(metrics.camera.y)}</div>
              </div>
            </div>
            <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)]">
              <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1 leading-none">
                Screen Res
              </div>
              <div className="text-[10px] font-bold text-[var(--text-main)] tabular-nums leading-relaxed">
                {metrics.canvas.screen.w} × {metrics.canvas.screen.h}
                <div className="text-[7.5px] text-indigo-500 uppercase font-black mt-0.5">
                  Scale: {metrics.scale.toFixed(2)}x
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 5. Viewport Metrics */}
        <div className="space-y-2 pt-2 border-t border-[var(--border-subtle)]">
          <div className="flex items-center gap-2">
            <Monitor size={11} className="text-[var(--text-muted)]" />
            <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
              Viewport Metrics
            </span>
          </div>
          <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] text-[9px] font-mono">
            <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1 leading-none">
              Resize Observer Dimension
            </div>
            <div className="text-[10px] font-bold text-[var(--text-muted)] tabular-nums font-bold">
              {Math.round(metrics.viewport.w)} ×{" "}
              {Math.round(metrics.viewport.h)} px
            </div>
          </div>
        </div>
      </div>
    </PopupPanel>
  );
});

/**
 * DebugInfoSettings: Contribution toggles in Settings Panel.
 * Uses toggleCmd execution handler provided by useDebugInfo, eliminating hard-coded command strings.
 */
export const DebugInfoSettings = React.memo(function DebugInfoSettings() {
  const { isEnabled, toggleCmd } = useDebugInfo();

  return (
    <>
      <FunctionButton
        title="System Debug Info"
        active={isEnabled}
        onClick={() => toggleCmd?.execute()}
      >
        <Terminal size={14} />
      </FunctionButton>
    </>
  );
});
