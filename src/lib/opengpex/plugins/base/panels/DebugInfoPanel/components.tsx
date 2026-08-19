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

import React, { useState } from "react";
import {
  MousePointer2,
  Target,
  Globe,
  Layout,
  Terminal,
  RotateCw,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Layers,
  Sparkles,
  AlertCircle,
  Activity,
  Cpu,
  Crosshair,
  ChevronDown,
  Database,
  Settings,
} from "lucide-react";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import Switch from "@opengpex/editor/widgets/Switch";
import { useEditorState, useEditorServices } from "@opengpex/editor/core/context";
import { LayersDrawerAPI } from "../../drawers/LayersDrawer/protocols";
import { useDebugInfo } from "./hooks";
import type { PerfMetrics, MemoryMetrics, DebugMetrics, AppResourceMetrics, TileStats } from "./hooks";
import { PopupPanel } from "@opengpex/editor/widgets/PopupPanel";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fpsColor(fps: number): string {
  if (fps >= 50) return "text-emerald-500";
  if (fps >= 30) return "text-amber-500";
  return "text-rose-500";
}

function fpsDotColor(fps: number): string {
  if (fps >= 50) return "bg-emerald-500";
  if (fps >= 30) return "bg-amber-500";
  return "bg-rose-500";
}

function memBarColor(pct: number): string {
  if (pct < 0.5) return "bg-emerald-500";
  if (pct < 0.75) return "bg-amber-500";
  return "bg-rose-500";
}

// ─── CollapsibleSection ──────────────────────────────────────────────────────

interface CollapsibleSectionProps {
  icon: React.ReactNode;
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  /** Optional right-side badge */
  badge?: React.ReactNode;
  /** Optional border-top separator */
  borderTop?: boolean;
  children: React.ReactNode;
}

function CollapsibleSection({ icon, title, isOpen, onToggle, badge, borderTop, children }: CollapsibleSectionProps) {
  return (
    <div className={`space-y-2 ${borderTop ? "pt-2 border-t border-[var(--border-subtle)]" : ""}`}>
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full cursor-pointer group/section"
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
            {title}
          </span>
          {badge}
        </div>
        <ChevronDown
          size={11}
          className={`text-[var(--text-muted)] group-hover/section:text-[var(--text-main)] transition-all duration-200 ${isOpen ? "" : "-rotate-90"}`}
        />
      </button>
      {isOpen && children}
    </div>
  );
}

// ─── Component Entry ─────────────────────────────────────────────────────────

/**
 * DebugInfoComponent (Outer Controller):
 * Subscribes to debug configuration and metrics.
 */
export const DebugInfoComponent = React.memo(function DebugInfoComponent() {
  const { metrics, perf, memory, resources, tiles, toggleCmd, isEnabled } = useDebugInfo();

  if (!isEnabled || !metrics) return null;

  return (
    <DebugInfoPanel
      metrics={metrics}
      perf={perf}
      memory={memory}
      resources={resources}
      tiles={tiles}
      onToggle={() => toggleCmd?.execute()}
    />
  );
});

// ─── Panel Props ─────────────────────────────────────────────────────────────

interface DebugInfoPanelProps {
  metrics: DebugMetrics;
  perf: PerfMetrics;
  memory: MemoryMetrics;
  resources: AppResourceMetrics;
  tiles: TileStats;
  onToggle: () => void;
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

const DebugInfoPanel = React.memo(function DebugInfoPanel({
  metrics,
  perf,
  memory,
  resources,
  tiles,
  onToggle,
}: DebugInfoPanelProps) {
  const { activeLayer } = metrics;
  const [showTop5, setShowTop5] = useState(false);
  const { state } = useEditorState();
  const { actions } = useEditorServices();

  // Section collapse state (Active Layer + Cursor Tracking default collapsed)
  const [sections, setSections] = useState({
    performance: true,
    tileCache: true,
    activeLayer: false,
    cursorTracking: false,
    canvasViewport: true,
    clipRegion: true,
    inspectorOptions: false,
  });
  const toggle = (key: keyof typeof sections) => setSections(s => ({ ...s, [key]: !s[key] }));

  const showSubLayers = state.getStateSignal(LayersDrawerAPI.signals.showSubLayers) ?? false;

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
      className="!h-[685px] !max-h-[685px]"
    >
      <div className="space-y-3.5 p-4 pr-3 text-[11px] text-[var(--text-main)] select-none overflow-y-auto max-h-[620px] scrollbar-hide">
        {/* ─── 1. Performance HUD ─────────────────────────────────────── */}
        <CollapsibleSection
          icon={<Activity size={11} className="text-[var(--text-muted)]" />}
          title="Performance"
          isOpen={sections.performance}
          onToggle={() => toggle('performance')}
        >
          <div className="bg-gradient-to-r from-[var(--bg-stage)] to-[var(--bg-stage)] p-3 rounded-2xl border border-[var(--border-subtle)] space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${fpsDotColor(perf.fps)} shadow-sm`} />
                  <span className={`text-[13px] font-black tabular-nums ${fpsColor(perf.fps)}`}>{perf.fps}</span>
                  <span className="text-[7px] font-bold text-[var(--text-muted)] uppercase">FPS</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-bold text-[var(--text-main)] tabular-nums">{perf.frameTime}</span>
                  <span className="text-[7px] font-bold text-[var(--text-muted)] uppercase">ms</span>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <span className="text-[8px] font-black text-[var(--text-muted)] bg-[var(--bg-panel)] px-1.5 py-0.5 rounded border border-[var(--border-subtle)]">DPR {metrics.dpr}x</span>
                <span className="text-[9px] font-black text-indigo-500 tabular-nums">{Math.round(metrics.scale * 100)}%</span>
              </div>
            </div>
            <div className="flex items-center justify-between pt-1.5 border-t border-[var(--border-subtle)]">
              <div className="flex items-center gap-1.5">
                <Crosshair size={9} className="text-[var(--text-muted)]" />
                <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-wider">Active Tool</span>
              </div>
              <span className="text-[9px] font-black text-[var(--text-main)] uppercase tracking-wide bg-indigo-500/10 px-2 py-0.5 rounded-md border border-indigo-500/20">{metrics.interactionMode}</span>
            </div>
            {memory.available && memory.jsHeap && (
              <div className="pt-1.5 border-t border-[var(--border-subtle)] space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Cpu size={9} className="text-[var(--text-muted)]" />
                    <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-wider">JS Heap</span>
                  </div>
                  <span className="text-[8px] font-bold text-[var(--text-main)] tabular-nums">{formatBytes(memory.jsHeap.used)} / {formatBytes(memory.jsHeap.limit)}</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-[var(--bg-panel)] border border-[var(--border-subtle)] overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${memBarColor(memory.jsHeap.pct)}`} style={{ width: `${Math.min(100, memory.jsHeap.pct * 100)}%` }} />
                </div>
                <div className="text-[7px] text-[var(--text-muted)] text-right tabular-nums font-bold">{(memory.jsHeap.pct * 100).toFixed(1)}% used</div>
              </div>
            )}
            {!memory.available && (
              <div className="pt-1.5 border-t border-[var(--border-subtle)]">
                <span className="text-[7.5px] text-[var(--text-muted)] italic">Memory API unavailable (Chrome/Edge only)</span>
              </div>
            )}
            <div className="pt-1.5 border-t border-[var(--border-subtle)] space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-wider">App Resources</span>
                <span className="text-[8px] font-bold text-[var(--text-main)] tabular-nums">{formatBytes(resources.totalAppBytes)}</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-[8px]">
                <div className="flex items-center justify-between bg-[var(--bg-panel)] px-2 py-1 rounded-md border border-[var(--border-subtle)]">
                  <span className="text-[7px] font-bold text-[var(--text-muted)] uppercase">Images</span>
                  <span className="font-bold text-[var(--text-main)] tabular-nums">{resources.assets.count} ({formatBytes(resources.assets.totalBytes)})</span>
                </div>
                {resources.tracked.totalCount > 0 && (
                  <div className="flex items-center justify-between bg-[var(--bg-panel)] px-2 py-1 rounded-md border border-[var(--border-subtle)]">
                    <span className="text-[7px] font-bold text-[var(--text-muted)] uppercase">Tracked</span>
                    <span className="font-bold text-[var(--text-main)] tabular-nums">{resources.tracked.totalCount} ({formatBytes(resources.tracked.totalBytes)})</span>
                  </div>
                )}
              </div>
              {resources.tracked.top5.length > 0 && (
                <div className="mt-1">
                  <button onClick={() => setShowTop5((v) => !v)} className="flex items-center gap-1.5 text-[7.5px] font-black text-indigo-500 uppercase tracking-wider hover:text-indigo-600 transition-colors cursor-pointer">
                    <Database size={8} />
                    <span>Top {Math.min(5, resources.tracked.top5.length)} Allocations</span>
                    <ChevronDown size={9} className={`transition-transform duration-200 ${showTop5 ? "rotate-180" : ""}`} />
                  </button>
                  {showTop5 && (
                    <div className="mt-1.5 space-y-1 animate-in fade-in slide-in-from-top-1 duration-200">
                      {resources.tracked.top5.map((alloc, idx) => (
                        <div key={alloc.id} className="flex items-center justify-between bg-[var(--bg-panel)] px-2 py-1 rounded-md border border-[var(--border-subtle)] text-[7.5px]">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[7px] font-black text-indigo-500 bg-indigo-500/10 w-3.5 h-3.5 rounded flex items-center justify-center flex-shrink-0">{idx + 1}</span>
                            <span className="font-bold text-[var(--text-main)] truncate max-w-[120px]" title={alloc.label || alloc.id}>{alloc.label || alloc.id.slice(0, 16)}</span>
                            <span className="text-[6.5px] font-bold text-[var(--text-muted)] uppercase bg-[var(--bg-stage)] px-1 py-0.5 rounded flex-shrink-0">{alloc.category.replace('_', ' ')}</span>
                          </div>
                          <span className="font-black text-[var(--text-main)] tabular-nums flex-shrink-0 ml-2">{formatBytes(alloc.bytes)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </CollapsibleSection>

        {/* ─── 1b. Tile Cache ─────────────────────────────────────────── */}
        {(tiles.cached > 0 || tiles.pending > 0) && (
          <CollapsibleSection
            icon={<Database size={11} className="text-[var(--text-muted)]" />}
            title="Tile Cache"
            isOpen={sections.tileCache}
            onToggle={() => toggle('tileCache')}
          >
            <div className="bg-[var(--bg-stage)] p-3 rounded-2xl border border-[var(--border-subtle)] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-wider">LRU Capacity</span>
                <span className="text-[8px] font-bold text-[var(--text-main)] tabular-nums">{tiles.cached} / {tiles.max}</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-[var(--bg-panel)] border border-[var(--border-subtle)] overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-500 ${tiles.utilization < 0.7 ? 'bg-emerald-500' : tiles.utilization < 0.9 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${Math.min(100, tiles.utilization * 100)}%` }} />
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-[8px]">
                <div className="flex flex-col items-center bg-[var(--bg-panel)] px-2 py-1.5 rounded-md border border-[var(--border-subtle)]">
                  <span className="text-[7px] font-bold text-[var(--text-muted)] uppercase">Cached</span>
                  <span className="font-black text-emerald-600 tabular-nums">{tiles.cached}</span>
                </div>
                <div className="flex flex-col items-center bg-[var(--bg-panel)] px-2 py-1.5 rounded-md border border-[var(--border-subtle)]">
                  <span className="text-[7px] font-bold text-[var(--text-muted)] uppercase">Empty</span>
                  <span className="font-black text-[var(--text-main)] tabular-nums">{tiles.empty}</span>
                </div>
                <div className="flex flex-col items-center bg-[var(--bg-panel)] px-2 py-1.5 rounded-md border border-[var(--border-subtle)]">
                  <span className="text-[7px] font-bold text-[var(--text-muted)] uppercase">Pending</span>
                  <span className={`font-black tabular-nums ${tiles.pending > 0 ? 'text-amber-500' : 'text-[var(--text-main)]'}`}>{tiles.pending}</span>
                </div>
              </div>
            </div>
          </CollapsibleSection>
        )}

        {/* ─── 2. Canvas & Camera ─────────────────────────────────────── */}
        <CollapsibleSection
          icon={<Layout size={11} className="text-[var(--text-muted)]" />}
          title="Canvas & Viewport"
          isOpen={sections.canvasViewport}
          onToggle={() => toggle('canvasViewport')}
          borderTop
        >
          <div className="grid grid-cols-3 gap-2 text-[9px] font-mono">
            <div className="bg-[var(--bg-stage)] p-2 rounded-xl border border-[var(--border-subtle)]">
              <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1 leading-none">Camera</div>
              <div className="text-[9.5px] font-bold text-[var(--text-main)] tabular-nums">X: {Math.round(metrics.camera.x)}</div>
              <div className="text-[9.5px] font-bold text-[var(--text-main)] tabular-nums">Y: {Math.round(metrics.camera.y)}</div>
            </div>
            <div className="bg-[var(--bg-stage)] p-2 rounded-xl border border-[var(--border-subtle)]">
              <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1 leading-none">Canvas</div>
              <div className="text-[9.5px] font-bold text-indigo-600 tabular-nums">{metrics.canvas.original.w}×{metrics.canvas.original.h}</div>
              <div className="text-[7px] font-bold text-[var(--text-muted)] mt-0.5 uppercase">Original</div>
            </div>
            <div className="bg-[var(--bg-stage)] p-2 rounded-xl border border-[var(--border-subtle)]">
              <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1 leading-none">Viewport</div>
              <div className="text-[9.5px] font-bold text-[var(--text-main)] tabular-nums">{metrics.viewport.w}×{metrics.viewport.h}</div>
              <div className="text-[7px] font-bold text-[var(--text-muted)] mt-0.5">DPR {metrics.dpr}x</div>
            </div>
          </div>
        </CollapsibleSection>

        {/* ─── 3. Active Layer Specs (default collapsed) ──────────────── */}
        <CollapsibleSection
          icon={<Layers size={11} className="text-[var(--text-muted)]" />}
          title="Active Layer"
          isOpen={sections.activeLayer}
          onToggle={() => toggle('activeLayer')}
        >
          {activeLayer ? (
            <div className="bg-gradient-to-br from-indigo-500/[0.03] to-violet-500/[0.03] border border-indigo-500/15 p-3 rounded-2xl space-y-2.5 transition-all">
              <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] font-black text-[var(--text-main)] truncate uppercase tracking-tight">{activeLayer.name}</span>
                  <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase tracking-wider mt-0.5 leading-none">Type: {activeLayer.type}</span>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <div className={`p-1 rounded-md ${activeLayer.visible ? "bg-indigo-500/10 text-indigo-500" : "bg-[var(--bg-panel)] text-[var(--text-muted)]"}`}>
                    {activeLayer.visible ? <Eye size={10} /> : <EyeOff size={10} />}
                  </div>
                  <div className={`p-1 rounded-md ${activeLayer.locked ? "bg-rose-500/10 text-rose-500" : "bg-emerald-500/10 text-emerald-500"}`}>
                    {activeLayer.locked ? <Lock size={10} /> : <Unlock size={10} />}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[9px] font-mono">
                <div className="p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 text-[7px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none"><Globe size={8} /> Position (TL)</div>
                  <div className="font-bold text-emerald-600 tabular-nums">X: {Math.round(activeLayer.local.x)}</div>
                  <div className="font-bold text-emerald-600 tabular-nums">Y: {Math.round(activeLayer.local.y)}</div>
                </div>
                <div className="p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 text-[7px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none"><Layout size={8} /> Dimension</div>
                  <div className="font-bold text-[var(--text-main)] tabular-nums">W: {Math.round(activeLayer.width)} px</div>
                  <div className="font-bold text-[var(--text-main)] tabular-nums">H: {Math.round(activeLayer.height)} px</div>
                </div>
                <div className="p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 text-[7px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none"><Target size={8} /> Center</div>
                  <div className="font-bold text-rose-600 tabular-nums">X: {Math.round(activeLayer.physical.x)}</div>
                  <div className="font-bold text-rose-600 tabular-nums">Y: {Math.round(activeLayer.physical.y)}</div>
                </div>
                <div className="p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 text-[7px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none"><RotateCw size={8} /> Transform</div>
                  <div className="font-bold text-indigo-600 tabular-nums">Rot: {Math.round(activeLayer.rotation)}°</div>
                  <div className="font-bold text-indigo-600 tabular-nums">Opa: {Math.round(activeLayer.opacity * 100)}%</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3.5 rounded-2xl bg-[var(--bg-stage)] border border-dashed border-[var(--border-subtle)] text-[var(--text-muted)] text-center flex-col justify-center">
              <AlertCircle size={14} className="opacity-50 text-indigo-500" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-black uppercase tracking-wider text-[var(--text-muted)]">No Selected Layer</span>
                <span className="text-[7.5px] leading-relaxed max-w-[210px] text-[var(--text-muted)]/80">Select a layer on the canvas to inspect coordinates and properties.</span>
              </div>
            </div>
          )}
        </CollapsibleSection>

        {/* ─── 3. Cursor Tracking (default collapsed) ─────────────────── */}
        <CollapsibleSection
          icon={<MousePointer2 size={11} className="text-[var(--text-muted)]" />}
          title="Cursor Tracking"
          isOpen={sections.cursorTracking}
          onToggle={() => toggle('cursorTracking')}
        >
          <div className="grid grid-cols-2 gap-2 text-[9px] font-mono">
            <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)]">
              <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1 leading-none">World Space</div>
              <div className="text-[10.5px] font-bold text-[var(--text-main)] tabular-nums">
                X: {Math.round(metrics.mouse.world.x)}
                <div className="mt-0.5">Y: {Math.round(metrics.mouse.world.y)}</div>
              </div>
            </div>
            <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)]">
              <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1 leading-none">Physical Space</div>
              <div className="text-[10.5px] font-bold text-[var(--text-main)] tabular-nums">
                X: {Math.round(metrics.mouse.physical.x)}
                <div className="mt-0.5">Y: {Math.round(metrics.mouse.physical.y)}</div>
              </div>
            </div>
          </div>
        </CollapsibleSection>

        {/* ─── 5. Clip Physics (Conditional) ──────────────────────────── */}
        {metrics.interactionMode === "clip" && metrics.clip.physical.w > 0 && (
          <CollapsibleSection
            icon={<Sparkles size={11} className="text-indigo-400" />}
            title="Clip Region"
            isOpen={sections.clipRegion}
            onToggle={() => toggle('clipRegion')}
            borderTop
          >
            <div className="bg-indigo-500/5 p-2.5 rounded-xl border border-indigo-500/15">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[9px] font-mono">
                <div className="font-bold text-indigo-600 tabular-nums">X: {Math.round(metrics.clip.physical.x)}</div>
                <div className="font-bold text-indigo-600 tabular-nums">Y: {Math.round(metrics.clip.physical.y)}</div>
                <div className="font-bold text-indigo-600 tabular-nums">W: {Math.round(metrics.clip.physical.w)} px</div>
                <div className="font-bold text-indigo-600 tabular-nums">H: {Math.round(metrics.clip.physical.h)} px</div>
              </div>
            </div>
          </CollapsibleSection>
        )}

        {/* ─── 6. Inspector Options ──────────────────────────────────── */}
        <CollapsibleSection
          icon={<Settings size={11} className="text-[var(--text-muted)]" />}
          title="Inspector Options"
          isOpen={sections.inspectorOptions}
          onToggle={() => toggle('inspectorOptions')}
          borderTop
        >
          <div className="bg-[var(--bg-stage)] p-3 rounded-2xl border border-[var(--border-subtle)] space-y-2">
            <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] leading-none mb-1">Layer Management Drawer</div>
            <div className="flex items-center justify-between">
              <span className="text-[9.5px] font-bold text-[var(--text-main)]">Show Sub-layers Button</span>
              <Switch checked={showSubLayers} onChange={(checked) => actions.setStateSignal(LayersDrawerAPI.signals.showSubLayers, checked)} />
            </div>
          </div>
        </CollapsibleSection>
      </div>
    </PopupPanel>
  );
});

// ─── Settings Toggle ─────────────────────────────────────────────────────────

/**
 * DebugInfoSettings: Contribution toggles in Settings Panel.
 */
export const DebugInfoSettings = React.memo(function DebugInfoSettings() {
  const { isEnabled, toggleCmd } = useDebugInfo();

  return (
    <>
      <FancyButton
        title="System Debug Info"
        active={isEnabled}
        onClick={() => toggleCmd?.execute()}
        iconOnly
        shape="rect"
      >
        <Terminal size={14} />
      </FancyButton>
    </>
  );
});
