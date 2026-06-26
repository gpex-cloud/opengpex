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

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Database,
  HardDrive,
  Layers,
  History,
  Trash2,
  ShieldCheck,
  Zap,
  X,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileCode,
  Monitor,
  Check,
  Cpu,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  AlertCircle,
  Package,
  Brain,
} from "lucide-react";
import {
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import DelayedConfirm from "@opengpex/editor/widgets/DelayedConfirm";
import { PopupPanel } from "@opengpex/editor/widgets/PopupPanel";
import {
  useStorageMetrics,
  useStorageConfig,
  useModelCacheMetrics,
  purgeModelCacheStorage,
  copyAssetUsages,
} from "./hooks";
import * as Prot from "./protocols";

/**
 * Format bytes to readable string
 */
const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

/**
 * StorageInfoComponent (Outer Controller):
 * Lightweight wrapper that subscribes to config/metrics.
 * Strictly delegates heavy UI rendering to a Memoized inner panel,
 * shielding children from high-frequency pan/zoom state changes.
 */
export function StorageInfoComponent() {
  const { state } = useEditorState();
  const { actions, assets, storage } = useEditorServices();
  const { summary: metrics, refresh, isRefreshing } = useStorageMetrics();
  const { isEnabled, toggleCmd } = useStorageConfig();

  // Create a mutable ref to store the latest state to keep callbacks stable
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const triggerGC = useCallback(() => {
    if (!metrics) return;
    const activeIds = new Set<string>();
    metrics.frames.forEach((f) => {
      if (f.thumbnail?.id) activeIds.add(f.thumbnail.id);
      f.layers.forEach((l) => {
        if (l.asset?.id) activeIds.add(l.asset.id);
        l.subLayers?.forEach((sub) => {
          if (sub.asset?.id) activeIds.add(sub.asset.id);
        });
      });
    });
    assets.sweep(activeIds, true);
    refresh();
  }, [metrics, assets, refresh]);

  const clearHistory = useCallback(() => {
    actions.history.purge();
    refresh();
  }, [actions.history, refresh]);

  const forceSave = useCallback(() => {
    storage.save(stateRef.current);
    refresh();
  }, [storage, refresh]);

  const purgeAll = useCallback(async () => {
    // Clear AI model cache from Cache Storage
    await purgeModelCacheStorage();
    await storage.clear();
    await assets.clear();
    window.location.reload();
  }, [storage, assets]);

  const handleSelectLayer = useCallback(
    (frameId: string, layerId: string) => {
      actions.switchFrame(frameId);
      actions.setActiveLayer(frameId, layerId);
    },
    [actions],
  );

  const handleSelectFrame = useCallback(
    (frameId: string) => {
      actions.switchFrame(frameId);
    },
    [actions],
  );

  if (!isEnabled || !metrics) return null;

  return (
    <StorageAuditPanel
      metrics={metrics}
      isRefreshing={isRefreshing}
      refresh={refresh}
      triggerGC={triggerGC}
      clearHistory={clearHistory}
      forceSave={forceSave}
      purgeAll={purgeAll}
      handleSelectLayer={handleSelectLayer}
      handleSelectFrame={handleSelectFrame}
      onClose={() => toggleCmd?.execute()}
    />
  );
}

interface InnerPanelProps {
  metrics: Prot.StorageSummary;
  isRefreshing: boolean;
  refresh: () => void;
  triggerGC: () => void;
  clearHistory: () => void;
  forceSave: () => void;
  purgeAll: () => Promise<void>;
  handleSelectLayer: (frameId: string, layerId: string) => void;
  handleSelectFrame: (frameId: string) => void;
  onClose: () => void;
}

/**
 * StorageAuditPanel (Inner Isolated View):
 * Wrapped in React.memo to ensure it NEVER re-renders when the user is
 * zooming, scrolling, or dragging the viewport.
 * Fully supports beautiful and highly-harmonious Light & Dark Mode layouts.
 */
const StorageAuditPanel = React.memo(function StorageAuditPanel({
  metrics,
  isRefreshing,
  refresh,
  triggerGC,
  clearHistory,
  forceSave,
  purgeAll,
  handleSelectLayer,
  handleSelectFrame,
  onClose,
}: InnerPanelProps) {
  // Downloaded AI model cache metrics (Cache Storage)
  const { modelCache, refreshModelCache } = useModelCacheMetrics();

  const purgeDownloadedModels = useCallback(async () => {
    await purgeModelCacheStorage();
    await refreshModelCache();
  }, [refreshModelCache]);

  // Tree nodes expanded state
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({
    project: true,
    history: false,
    detached: false,
  });

  // Selected item details in tree explorer
  const [selectedNode, setSelectedNode] = useState<{
    type: "frame" | "layer" | "asset" | "history";
    id: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any;
  } | null>(null);

  // Active hover preview card for assets
  const [hoveredAsset, setHoveredAsset] = useState<Prot.AssetMetric | null>(null);

  const toggleNode = (nodeKey: string) => {
    setExpandedNodes((prev) => ({
      ...prev,
      [nodeKey]: !prev[nodeKey],
    }));
  };

  // 1. Data Classification calculations
  const activeSize = metrics.frames.reduce((sum, f) => {
    let fSum = 0;
    if (f.thumbnail) fSum += f.thumbnail.size;
    f.layers.forEach((l) => {
      if (l.asset) fSum += l.asset.size;
      l.subLayers?.forEach((sub) => {
        if (sub.asset) fSum += sub.asset.size;
      });
    });
    return sum + fSum;
  }, 0);

  const historySize = metrics.history.reduce(
    (sum, h) => sum + h.exclusiveSize,
    0,
  );
  const orphanSize = metrics.detached.reduce((sum, a) => sum + a.size, 0);
  const stateSize = metrics.stateBytes || 0;
  const modelSize = modelCache.totalBytes;
  const grandTotal = activeSize + historySize + orphanSize + stateSize + modelSize || 1;

  const pActive = (activeSize / grandTotal) * 100;
  const pHistory = (historySize / grandTotal) * 100;
  const pOrphan = (orphanSize / grandTotal) * 100;
  const pState = (stateSize / grandTotal) * 100;
  const pModels = (modelSize / grandTotal) * 100;

  // --- DUAL MODE RENDERING ---
  return (
    <PopupPanel
      isVisible={true}
      onClose={onClose}
      title="Storage Audit Console"
      subTitle="CAS Topology & IndexedDB Persistence"
      icon={<Database size={14} />}
      status="STABLE"
      mode="responsive"
      size="sm"
      position="BR"
      closeOnOutsideClick={false}
    >
      {(isExpanded) => (
        <>
          {/* HUD MODE (Compact) */}
          {!isExpanded ? (
            <div className="flex flex-col gap-3 p-5 font-sans text-[var(--text-muted)] select-none h-full">
              {/* Refresh button row */}
              <div className="flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-2">
                  <Zap size={8} className="text-indigo-500 animate-bounce" />
                  <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-widest">
                    Live Linked
                  </span>
                </div>
                <button
                  onClick={refresh}
                  disabled={isRefreshing}
                  className={`p-1.5 rounded-md transition-all ${isRefreshing ? "bg-indigo-500/10 text-indigo-600 " : "text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)]"}`}
                  title="Refresh Audit"
                >
                  <RefreshCw
                    size={12}
                    className={isRefreshing ? "animate-spin" : ""}
                  />
                </button>
              </div>

              {/* Compact stats grid */}
              <div className="grid grid-cols-2 gap-2 flex-shrink-0">
                <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                  <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1">
                    TOTAL ASSETS
                  </div>
                  <div className="text-sm font-mono text-[var(--text-main)] font-bold tabular-nums">
                    {formatBytes(metrics.totalBytes)}
                  </div>
                </div>
                <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                  <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1">
                    DATABASE STATE
                  </div>
                  <div className="text-sm font-mono text-[var(--text-main)] font-bold tabular-nums">
                    {formatBytes(metrics.stateBytes)}
                  </div>
                </div>
                {modelCache.totalBytes > 0 && (
                  <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-purple-200 dark:border-purple-500/20 col-span-2">
                    <div className="text-[7px] font-black uppercase tracking-widest text-purple-500 mb-1 flex items-center gap-1">
                      <Brain size={8} />
                      AI MODELS CACHE
                    </div>
                    <div className="text-sm font-mono text-[var(--text-main)] font-bold tabular-nums">
                      {formatBytes(modelCache.totalBytes)}
                      <span className="text-[8px] text-[var(--text-muted)] font-normal ml-1.5">
                        ({modelCache.fileCount} files)
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Dynamic Topology Explorer */}
              <div className="flex-1 overflow-y-auto pr-1 space-y-4 scrollbar-hide py-2">
                {/* Active Frames Section */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2 pl-1 opacity-50">
                    <HardDrive size={10} />
                    <span className="text-[9px] font-black uppercase tracking-widest">
                      Active Workspace
                    </span>
                  </div>

                  {metrics.frames.map((frame) => (
                    <div
                      key={frame.id}
                      className="bg-[var(--bg-stage)] rounded-xl border border-[var(--border-subtle)] dark:border-white/[0.08] overflow-hidden"
                    >
                      {/* Frame Header */}
                      <div className="bg-[var(--bg-stage)] px-3 py-1.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] flex items-center justify-between">
                        <div
                          className="flex items-center gap-1.5 min-w-0 cursor-pointer"
                          onClick={() => handleSelectFrame(frame.id)}
                        >
                          <span className="text-[8px] font-black text-indigo-600 uppercase px-1 rounded bg-indigo-500/10 ">
                            Frame
                          </span>
                          <span className="text-[9px] font-bold text-[var(--text-main)] truncate">
                            {frame.name}
                          </span>
                        </div>
                        <span className="text-[8px] font-mono opacity-40">
                          #{frame.id.slice(0, 4)}
                        </span>
                      </div>

                      {/* Layers in this frame */}
                      <div className="p-2 space-y-1">
                        {frame.thumbnail && (
                          <div className="flex items-center justify-between text-[9px] p-1 rounded hover transition-colors">
                            <span className="text-[var(--text-muted)] flex items-center gap-1">
                              🖼️ Thumbnail
                            </span>
                            <span className="font-mono opacity-65">
                              {formatBytes(frame.thumbnail.size)}
                            </span>
                          </div>
                        )}
                        {frame.layers.map((layer) =>
                          layer.asset ? (
                            <div
                              key={layer.id}
                              className="flex items-center justify-between text-[9px] p-1 rounded hover cursor-pointer transition-colors"
                              onClick={() =>
                                handleSelectLayer(frame.id, layer.id)
                              }
                              title="Click to select layer"
                            >
                              <span className="text-[var(--text-main)] truncate max-w-[140px] flex items-center gap-1">
                                📁 {layer.name}
                              </span>
                              <span className="font-mono text-indigo-650 ">
                                {formatBytes(layer.asset.size)}
                              </span>
                            </div>
                          ) : null,
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Compact Orphans Section */}
                {metrics.detached.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 pl-1 text-rose-500 opacity-80">
                      <Trash2 size={10} />
                      <span className="text-[9px] font-black uppercase tracking-widest">
                        Detached Trash ({metrics.detached.length})
                      </span>
                    </div>
                    <div className="bg-rose-500/5 rounded-xl border border-rose-500/20 p-2 text-[9px] space-y-1">
                      {metrics.detached.slice(0, 3).map((asset) => (
                        <div
                          key={asset.id}
                          className="flex justify-between items-center text-rose-500 opacity-80"
                        >
                          <span className="truncate max-w-[150px] font-mono">
                            {asset.id.slice(0, 12)}
                          </span>
                          <span className="font-mono">
                            {formatBytes(asset.size)}
                          </span>
                        </div>
                      ))}
                      {metrics.detached.length > 3 && (
                        <div className="text-[8px] opacity-60 text-center pt-1 text-rose-500">
                          + {metrics.detached.length - 3} more orphans
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="pt-2 border-t border-[var(--border-subtle)] dark:border-t-white/[0.06] flex items-center justify-between opacity-50 flex-shrink-0">
                <span className="text-[8px] font-mono text-[var(--text-muted)] ">
                  v2.5 optimized
                </span>
              </div>
            </div>
          ) : (
            /* DASHBOARD MODE */
            <div className="flex-1 min-h-0 flex font-sans text-[var(--text-main)] select-none">
              {/* Left Column - Analytics Dashboard */}
              <div className="w-[380px] border-r border-[var(--border-subtle)] dark:border-r-white/[0.06] p-6 flex flex-col gap-6 overflow-y-auto bg-[var(--bg-stage)] ">
                {/* Classification Segment Bar */}
                <div className="space-y-3">
                  <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] flex items-center justify-between">
                    <span>Storage Allocation</span>
                    <span className="font-mono text-[var(--text-main)] font-bold">
                      {formatBytes(metrics.totalBytes + metrics.stateBytes)}
                    </span>
                  </div>

                  {/* Segment Bar Container */}
                  <div className="h-3 w-full bg-[var(--bg-stage)] rounded-full overflow-hidden flex ring-1 ring-inset ring-black/5 ">
                    <div
                      style={{ width: `${pActive}%` }}
                      className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500"
                      title="Active Frame Assets"
                    />
                    <div
                      style={{ width: `${pHistory}%` }}
                      className="h-full bg-gradient-to-r from-amber-500 to-orange-500 transition-all duration-500"
                      title="History Snapshots"
                    />
                    <div
                      style={{ width: `${pOrphan}%` }}
                      className="h-full bg-gradient-to-r from-rose-500 to-red-500 transition-all duration-500"
                      title="Detached Orphans"
                    />
                    <div
                      style={{ width: `${pState}%` }}
                      className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500"
                      title="Database State Size"
                    />
                    <div
                      style={{ width: `${pModels}%` }}
                      className="h-full bg-gradient-to-r from-purple-500 to-fuchsia-500 transition-all duration-500"
                      title="Downloaded Models (Cache Storage)"
                    />
                  </div>

                  {/* Legends Grid */}
                  <div className="grid grid-cols-2 gap-2.5 pt-1 text-[9px]">
                    <div className="flex flex-col gap-1 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                      <div className="flex items-center gap-1.5 text-[var(--text-muted)] ">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                        <span>Active Frames</span>
                      </div>
                      <span className="font-mono text-[var(--text-main)] font-bold pl-3">
                        {formatBytes(activeSize)} ({pActive.toFixed(1)}%)
                      </span>
                    </div>

                    <div className="flex flex-col gap-1 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                      <div className="flex items-center gap-1.5 text-[var(--text-muted)] ">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                        <span>Undo Backlog</span>
                      </div>
                      <span className="font-mono text-[var(--text-main)] font-bold pl-3">
                        {formatBytes(historySize)} ({pHistory.toFixed(1)}%)
                      </span>
                    </div>

                    <div className="flex flex-col gap-1 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                      <div className="flex items-center gap-1.5 text-[var(--text-muted)] ">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                        <span>Detached Trash</span>
                      </div>
                      <span className="font-mono text-[var(--text-main)] font-bold pl-3">
                        {formatBytes(orphanSize)} ({pOrphan.toFixed(1)}%)
                      </span>
                    </div>

                    <div className="flex flex-col gap-1 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                      <div className="flex items-center gap-1.5 text-[var(--text-muted)] ">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        <span>DB State Shards</span>
                      </div>
                      <span className="font-mono text-[var(--text-main)] font-bold pl-3">
                        {formatBytes(stateSize)} ({pState.toFixed(1)}%)
                      </span>
                    </div>

                    <div className="flex flex-col gap-1 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] col-span-2">
                      <div className="flex items-center gap-1.5 text-[var(--text-muted)] ">
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                        <Brain size={9} className="text-purple-500" />
                        <span>Downloaded Models</span>
                      </div>
                      <span className="font-mono text-[var(--text-main)] font-bold pl-3">
                        {formatBytes(modelSize)} ({pModels.toFixed(1)}%)
                        {modelCache.fileCount > 0 && (
                          <span className="text-[var(--text-muted)] font-normal ml-2">
                            {modelCache.fileCount} files
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Shard & Database Metrics */}
                <div className="space-y-3 bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] p-4 rounded-2xl">
                  <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] flex items-center justify-between">
                    <span>IndexedDB Shard Index</span>
                    <span className="font-mono text-[9px] text-[var(--text-muted)] ">
                      {metrics.shards.length} Shards
                    </span>
                  </div>

                  <div className="space-y-1.5 text-[9px] font-mono">
                    {metrics.shards.map((shard) => (
                      <div
                        key={shard.key}
                        className="flex justify-between items-center py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] last:border-0 text-[var(--text-muted)] "
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-1 h-1 rounded ${
                              shard.type === "project_meta"
                                ? "bg-indigo-500"
                                : shard.type === "frame"
                                  ? "bg-emerald-500"
                                  : "bg-amber-500"
                            }`}
                          />
                          <span>{shard.key}</span>
                        </div>
                        <span className="text-[var(--text-muted)] font-bold">
                          {formatBytes(shard.sizeBytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Performance Indicators */}
                <div className="space-y-3">
                  <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] ">
                    System Profiles
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[9px]">
                    <div className="p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] flex items-center gap-2">
                      <Cpu size={12} className="text-indigo-500 " />
                      <div>
                        <div className="text-[var(--text-muted)] leading-none mb-0.5 font-bold uppercase tracking-tight">
                          HARDWARE LEVEL
                        </div>
                        <div className="font-bold text-[var(--text-main)] uppercase">
                          Mid-High Tier
                        </div>
                      </div>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] flex items-center gap-2">
                      <ShieldCheck size={12} className="text-emerald-500 " />
                      <div>
                        <div className="text-[var(--text-muted)] leading-none mb-0.5 font-bold uppercase tracking-tight">
                          LIFE CYCLE
                        </div>
                        <div className="font-bold text-[var(--text-main)] uppercase">
                          GC Defended
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Action Suite Control panel */}
                <div className="mt-auto pt-4 border-t border-[var(--border-subtle)] dark:border-t-white/[0.06] space-y-4">
                  {/* Utilities */}
                  <div className="flex gap-2">
                    <FancyButton
                      onClick={triggerGC}
                      variant="zinc"
                      shape="pill"
                      size="xs"
                      subtle
                    >
                      <Trash2 size={10} />
                      Force GC
                    </FancyButton>
                    <FancyButton
                      onClick={forceSave}
                      variant="zinc"
                      shape="pill"
                      size="xs"
                      subtle
                    >
                      <HardDrive size={10} />
                      Save Shards
                    </FancyButton>
                  </div>

                  {/* Data Purging */}
                  <div className="space-y-2 p-3 rounded-xl border border-[var(--border-subtle)] dark:border-white/[0.08] bg-[var(--bg-stage)]">
                    <div className="text-[8px] font-black uppercase tracking-widest text-[var(--text-muted)]">
                      Data Purging
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <DelayedConfirm
                        onConfirm={purgeAll}
                        delayTime={3000}
                        confirmClassName="bg-rose-500/20"
                        ringColor="text-rose-500"
                      >
                        <FancyButton variant="red" shape="pill" size="xs" subtle>
                          <Trash2 size={10} />
                          Wipe All
                        </FancyButton>
                      </DelayedConfirm>

                      <FancyButton
                        onClick={clearHistory}
                        variant="amber"
                        shape="pill"
                        size="xs"
                        subtle
                      >
                        <History size={10} />
                        History
                      </FancyButton>

                      {modelCache.totalBytes > 0 && (
                        <DelayedConfirm
                          onConfirm={purgeDownloadedModels}
                          delayTime={2000}
                          confirmClassName="bg-purple-500/20"
                          ringColor="text-purple-500"
                        >
                          <FancyButton variant="indigo" shape="pill" size="xs" subtle>
                            <Brain size={10} />
                            AI Models
                          </FancyButton>
                        </DelayedConfirm>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Column - Topology Tree Explorer & Detail Pane */}
              <div className="flex-1 flex min-w-0">
                {/* Tree Section */}
                <div className="flex-1 overflow-y-auto p-6 min-w-0 scrollbar-hide space-y-4">
                  <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] pl-1">
                    Resource Topology tree
                  </div>

                  {/* Dynamic Interactive Tree Outline */}
                  <div className="space-y-1 select-none font-mono text-[10px]">
                    {/* 1. Root: Project Node */}
                    <div className="flex flex-col">
                      <div
                        onClick={() => toggleNode("project")}
                        className="flex items-center gap-2 py-1 px-2 rounded-lg hover cursor-pointer text-[var(--text-main)] font-bold transition-colors"
                      >
                        {expandedNodes.project ? (
                          <ChevronDown
                            size={12}
                            className="text-[var(--text-muted)]"
                          />
                        ) : (
                          <ChevronRight
                            size={12}
                            className="text-[var(--text-muted)]"
                          />
                        )}
                        {expandedNodes.project ? (
                          <FolderOpen size={12} className="text-indigo-500 " />
                        ) : (
                          <Folder size={12} className="text-indigo-500 " />
                        )}
                        <span>OpenGPEX</span>
                      </div>

                      {expandedNodes.project && (
                        <div className="pl-4 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-3.5 mt-0.5 space-y-1">
                          {/* Frame Nodes */}
                          {metrics.frames.map((frame) => {
                            const frameKey = `frame:${frame.id}`;
                            const isFrameExpanded =
                              expandedNodes[frameKey] === true;

                            return (
                              <div key={frame.id} className="flex flex-col">
                                <div
                                  onClick={() => toggleNode(frameKey)}
                                  className={`flex items-center justify-between py-1 px-2 rounded-lg hover cursor-pointer transition-colors ${selectedNode?.id === frame.id ? "bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 text-indigo-650 " : "text-[var(--text-muted)]"}`}
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    {isFrameExpanded ? (
                                      <ChevronDown
                                        size={11}
                                        className="text-[var(--text-muted)]"
                                      />
                                    ) : (
                                      <ChevronRight
                                        size={11}
                                        className="text-[var(--text-muted)]"
                                      />
                                    )}
                                    <Monitor
                                      size={11}
                                      className="text-emerald-500 "
                                    />
                                    <span className="font-bold truncate">
                                      {frame.name}
                                    </span>
                                  </div>

                                  <div className="flex items-center gap-2 flex-shrink-0">
                                    <span className="text-[8px] font-normal text-[var(--text-muted)] ">
                                      {frame.canvas.w}x{frame.canvas.h}px
                                    </span>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleSelectFrame(frame.id);
                                        setSelectedNode({
                                          type: "frame",
                                          id: frame.id,
                                          data: frame,
                                        });
                                      }}
                                      className="p-0.5 rounded bg-[var(--bg-stage)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)] "
                                      title="Activate frame in workspace"
                                    >
                                      <Check size={8} />
                                    </button>
                                  </div>
                                </div>

                                {/* Expanded Frame items */}
                                {isFrameExpanded && (
                                  <div className="pl-4 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-3 mt-0.5 space-y-1">
                                    {/* Frame Thumbnail Item */}
                                    {frame.thumbnail && (
                                      <div
                                        onClick={() =>
                                          setSelectedNode({
                                            type: "asset",
                                            id: frame.thumbnail!.id,
                                            data: frame.thumbnail,
                                          })
                                        }
                                        onMouseEnter={() =>
                                          setHoveredAsset(frame.thumbnail || null)
                                        }
                                        onMouseLeave={() =>
                                          setHoveredAsset(null)
                                        }
                                        className="flex items-center justify-between py-0.5 px-2 rounded hover cursor-pointer text-[var(--text-muted)] "
                                      >
                                        <div className="flex items-center gap-2 min-w-0">
                                          <FileCode
                                            size={10}
                                            className="text-[var(--text-muted)] "
                                          />
                                          <span className="truncate">
                                            thumbnail.raw
                                          </span>
                                        </div>
                                        <span className="text-[8px] opacity-60">
                                          {formatBytes(frame.thumbnail.size)}
                                        </span>
                                      </div>
                                    )}

                                    {/* Frame Layers collection */}
                                    <div className="flex flex-col">
                                      <div
                                        onClick={() =>
                                          toggleNode(`${frameKey}:layers`)
                                        }
                                        className="flex items-center gap-1.5 py-0.5 px-2 text-[var(--text-muted)] cursor-pointer"
                                      >
                                        {expandedNodes[`${frameKey}:layers`] !==
                                        false ? (
                                          <ChevronDown size={10} />
                                        ) : (
                                          <ChevronRight size={10} />
                                        )}
                                        <Layers size={10} />
                                        <span>
                                          layers ({frame.layers.length})
                                        </span>
                                      </div>

                                      {expandedNodes[`${frameKey}:layers`] !==
                                        false && (
                                        <div className="pl-3 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-3.5 space-y-0.5">
                                          {frame.layers.map((layer) => {
                                            return (
                                              <div
                                                key={layer.id}
                                                onClick={() =>
                                                  setSelectedNode({
                                                    type: "layer",
                                                    id: layer.id,
                                                    data: {
                                                      ...layer,
                                                      frameId: frame.id,
                                                    },
                                                  })
                                                }
                                                className={`flex items-center justify-between py-0.5 px-2 rounded hover cursor-pointer transition-colors ${selectedNode?.id === layer.id ? "bg-indigo-500/10 text-indigo-500 font-bold" : "text-[var(--text-muted)]"}`}
                                                onMouseEnter={() =>
                                                  layer.asset &&
                                                  setHoveredAsset(layer.asset)
                                                }
                                                onMouseLeave={() =>
                                                  setHoveredAsset(null)
                                                }
                                              >
                                                <div className="flex items-center gap-1.5 min-w-0">
                                                  <span className="text-[var(--text-muted)] ">
                                                    •
                                                  </span>
                                                  <span className="truncate">
                                                    {layer.name}
                                                  </span>
                                                </div>
                                                <div className="flex items-center gap-2 flex-shrink-0">
                                                  <div className="flex items-center gap-1">
                                                    {layer.visible ? (
                                                      <Eye
                                                        size={9}
                                                        className="text-[var(--text-muted)] "
                                                      />
                                                    ) : (
                                                      <EyeOff
                                                        size={9}
                                                        className="text-rose-500"
                                                      />
                                                    )}
                                                    {layer.locked ? (
                                                      <Lock
                                                        size={9}
                                                        className="text-[var(--text-muted)] "
                                                      />
                                                    ) : (
                                                      <Unlock
                                                        size={9}
                                                        className="text-[var(--text-muted)] "
                                                      />
                                                    )}
                                                  </div>
                                                  <button
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      handleSelectLayer(
                                                        frame.id,
                                                        layer.id,
                                                      );
                                                      setSelectedNode({
                                                        type: "layer",
                                                        id: layer.id,
                                                        data: {
                                                          ...layer,
                                                          frameId: frame.id,
                                                        },
                                                      });
                                                    }}
                                                    className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)] "
                                                    title="Select layer on canvas"
                                                  >
                                                    <Check size={8} />
                                                  </button>
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}

                          {/* 2. History Backlog Folder Node */}
                          <div className="flex flex-col">
                            <div
                              onClick={() => toggleNode("history")}
                              className="flex items-center gap-2 py-1 px-2 rounded-lg hover cursor-pointer text-[var(--text-main)] font-bold transition-colors"
                            >
                              {expandedNodes.history ? (
                                <ChevronDown
                                  size={11}
                                  className="text-[var(--text-muted)]"
                                />
                              ) : (
                                <ChevronRight
                                  size={11}
                                  className="text-[var(--text-muted)]"
                                />
                              )}
                              <History size={11} className="text-amber-500 " />
                              <span>
                                history-backlog ({metrics.history.length}{" "}
                                snapshots)
                              </span>
                            </div>

                            {expandedNodes.history && (
                              <div className="pl-4 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-3.5 space-y-1 mt-0.5">
                                {metrics.history.map((moment) => (
                                  <div
                                    key={moment.id}
                                    onClick={() =>
                                      setSelectedNode({
                                        type: "history",
                                        id: moment.id,
                                        data: moment,
                                      })
                                    }
                                    className={`flex justify-between items-center py-0.5 px-2 rounded hover cursor-pointer ${selectedNode?.id === moment.id ? "bg-amber-500/10 text-amber-500 font-bold" : "text-[var(--text-muted)]"}`}
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                                      <span className="truncate">
                                        {moment.label}
                                      </span>
                                    </div>
                                    <span className="font-mono text-[8px] text-[var(--text-muted)] ">
                                      {formatBytes(moment.exclusiveSize)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* 3. Detached Orphans Folder Node */}
                          <div className="flex flex-col">
                            <div
                              onClick={() => toggleNode("detached")}
                              className="flex items-center gap-2 py-1 px-2 rounded-lg hover cursor-pointer text-[var(--text-main)] font-bold transition-colors"
                            >
                              {expandedNodes.detached ? (
                                <ChevronDown
                                  size={11}
                                  className="text-[var(--text-muted)]"
                                />
                              ) : (
                                <ChevronRight
                                  size={11}
                                  className="text-[var(--text-muted)]"
                                />
                              )}
                              <Trash2 size={11} className="text-rose-500 " />
                              <span>
                                global-detached-cache ({metrics.detached.length}
                                {""}
                                orphans)
                              </span>
                            </div>

                            {expandedNodes.detached && (
                              <div className="pl-4 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-3.5 space-y-1 mt-0.5">
                                {metrics.detached.map((asset) => (
                                  <div
                                    key={asset.id}
                                    onClick={() =>
                                      setSelectedNode({
                                        type: "asset",
                                        id: asset.id,
                                        data: asset,
                                      })
                                    }
                                    onMouseEnter={() => setHoveredAsset(asset)}
                                    onMouseLeave={() => setHoveredAsset(null)}
                                    className={`flex justify-between items-center py-0.5 px-2 rounded hover cursor-pointer ${selectedNode?.id === asset.id ? "bg-rose-500/10 text-rose-500 font-bold" : "text-[var(--text-muted)]"}`}
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                                      <span className="truncate font-mono">
                                        {asset.id.slice(0, 14)}
                                      </span>
                                    </div>
                                    <span className="font-mono text-[8px] text-[var(--text-muted)] ">
                                      {formatBytes(asset.size)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* 4. Downloaded Models (Cache Storage) Folder Node */}
                          <div className="flex flex-col">
                            <div
                              onClick={() => toggleNode("models")}
                              className="flex items-center gap-2 py-1 px-2 rounded-lg hover cursor-pointer text-[var(--text-main)] font-bold transition-colors"
                            >
                              {expandedNodes.models ? (
                                <ChevronDown
                                  size={11}
                                  className="text-[var(--text-muted)]"
                                />
                              ) : (
                                <ChevronRight
                                  size={11}
                                  className="text-[var(--text-muted)]"
                                />
                              )}
                              <Brain size={11} className="text-purple-500 " />
                              <span>
                                downloaded-models ({modelCache.fileCount} files)
                              </span>
                            </div>

                            {expandedNodes.models && (
                              <div className="pl-4 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-3.5 space-y-1 mt-0.5">
                                {modelCache.fileCount > 0 ? (
                                  <>
                                    <div className="flex justify-between items-center py-0.5 px-2 text-[var(--text-muted)]">
                                      <div className="flex items-center gap-2 min-w-0">
                                        <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                                        <span>Total Size</span>
                                      </div>
                                      <span className="font-mono text-[8px] text-purple-500 font-bold">
                                        {formatBytes(modelCache.totalBytes)}
                                      </span>
                                    </div>
                                    {modelCache.files.map((file, idx) => (
                                      <div
                                        key={`${file.cacheName}-${idx}`}
                                        className="flex justify-between items-center py-0.5 px-2 text-[var(--text-muted)]"
                                        title={file.url}
                                      >
                                        <div className="flex items-center gap-2 min-w-0">
                                          <span className="w-1 h-1 rounded bg-purple-400" />
                                          <span className="truncate text-[9px] font-mono">
                                            {file.name}
                                          </span>
                                        </div>
                                        <span className="font-mono text-[8px] text-[var(--text-muted)] flex-shrink-0 ml-2">
                                          {formatBytes(file.size)}
                                        </span>
                                      </div>
                                    ))}
                                  </>
                                ) : (
                                  <div className="py-1 px-2 text-[var(--text-muted)] text-[9px] opacity-60">
                                    No models downloaded yet
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Details Inspector Pane (Right Part of Tree Explorer) */}
                <div className="w-[300px] border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] p-6 flex flex-col gap-5 overflow-y-auto bg-[var(--bg-stage)] relative select-none">
                  {selectedNode ? (
                    <>
                      {/* Header */}
                      <div className="flex justify-between items-start border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] pb-3">
                        <div>
                          <span className="text-[8px] font-black uppercase px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-650 font-mono">
                            {selectedNode.type} Details
                          </span>
                          <h4 className="text-xs font-bold text-[var(--text-main)] mt-2 truncate max-w-[200px]">
                            {selectedNode.type === "frame" &&
                              selectedNode.data.name}
                            {selectedNode.type === "layer" &&
                              selectedNode.data.name}
                            {selectedNode.type === "asset" &&
                              `Asset: ${selectedNode.data.id.slice(0, 8)}`}
                            {selectedNode.type === "history" &&
                              selectedNode.data.label}
                          </h4>
                        </div>
                        <button
                          onClick={() => setSelectedNode(null)}
                          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)] "
                        >
                          <X size={12} />
                        </button>
                      </div>

                      {/* Attributes Inspector list */}
                      <div className="space-y-4 text-[9px] font-mono">
                        {/* Frame Attributes */}
                        {selectedNode.type === "frame" && (
                          <div className="space-y-2">
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                FRAME ID
                              </span>
                              <span className="text-[var(--text-main)] truncate max-w-[160px]">
                                {selectedNode.data.id}
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                CANVAS WIDTH
                              </span>
                              <span className="text-[var(--text-main)] ">
                                {selectedNode.data.canvas.w} px
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                CANVAS HEIGHT
                              </span>
                              <span className="text-[var(--text-main)] ">
                                {selectedNode.data.canvas.h} px
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                CAMERA SCALE
                              </span>
                              <span className="text-[var(--text-main)] ">
                                {(selectedNode.data.camera.k * 100).toFixed(1)}{" "}
                                %
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                CAMERA COORD
                              </span>
                              <span className="text-[var(--text-main)] ">
                                X: {selectedNode.data.camera.x.toFixed(0)}, Y:
                                {""}
                                {selectedNode.data.camera.y.toFixed(0)}
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                LAYERS TOTAL
                              </span>
                              <span className="text-indigo-650 ">
                                {selectedNode.data.layers.length} Layers
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Layer Attributes */}
                        {selectedNode.type === "layer" && (
                          <div className="space-y-2">
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                LAYER ID
                              </span>
                              <span className="text-[var(--text-main)] truncate max-w-[160px]">
                                {selectedNode.data.id}
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                TYPE
                              </span>
                              <span className="text-indigo-600 uppercase font-black">
                                {selectedNode.data.type}
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                OPACITY
                              </span>
                              <span className="text-[var(--text-main)] ">
                                {selectedNode.data.opacity} %
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                VISIBILITY
                              </span>
                              <span
                                className={
                                  selectedNode.data.visible
                                    ? "text-emerald-600 "
                                    : "text-rose-600 "
                                }
                              >
                                {selectedNode.data.visible
                                  ? "Visible"
                                  : "Hidden"}
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                LOCKED
                              </span>
                              <span className="text-[var(--text-main)] ">
                                {selectedNode.data.locked ? "Yes" : "No"}
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                BOUNDS
                              </span>
                              <span className="text-[var(--text-main)] ">
                                {selectedNode.data.bounding.w}x
                                {selectedNode.data.bounding.h} px
                              </span>
                            </div>

                            {selectedNode.data.asset ? (
                              <div className="mt-4 pt-4 border-t border-[var(--border-subtle)] dark:border-t-white/[0.06] space-y-2">
                                <div className="text-[8px] font-black uppercase text-[var(--text-muted)] ">
                                  Linked Physical Asset
                                </div>
                                <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                                  <span className="text-[var(--text-muted)] ">
                                    HASH ID
                                  </span>
                                  <span className="text-[var(--text-main)] truncate max-w-[160px]">
                                    {selectedNode.data.asset.id}
                                  </span>
                                </div>
                                <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                                  <span className="text-[var(--text-muted)] ">
                                    FILE SIZE
                                  </span>
                                  <span className="text-indigo-650 font-bold">
                                    {formatBytes(selectedNode.data.asset.size)}
                                  </span>
                                </div>
                                <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                                  <span className="text-[var(--text-muted)] ">
                                    MIME-TYPE
                                  </span>
                                  <span className="text-[var(--text-main)] truncate max-w-[140px]">
                                    {selectedNode.data.asset.type}
                                  </span>
                                </div>
                                <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                                  <span className="text-[var(--text-muted)] ">
                                    REF COUNT
                                  </span>
                                  <span className="text-emerald-600 ">
                                    {selectedNode.data.asset.refCount} refs
                                  </span>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 mt-2 text-[8px]">
                                <AlertCircle size={10} />
                                <span>
                                  No asset bound to layer (Text / Vector /
                                  Color)
                                </span>
                              </div>
                            )}

                            {/* Cascade Sub Layers Display */}
                            {selectedNode.data.subLayers &&
                              selectedNode.data.subLayers.length > 0 && (
                                <div className="mt-4 pt-4 border-t border-[var(--border-subtle)] dark:border-t-white/[0.06] space-y-2">
                                  <div className="text-[8px] font-black uppercase text-[var(--text-muted)] ">
                                    Sub Layers (Cascade Roles)
                                  </div>
                                  <div className="space-y-2">
                                    {selectedNode.data.subLayers.map(
                                      (sub: Prot.LayerMetric) => (
                                        <div
                                          key={sub.id}
                                          className="p-2 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] space-y-1.5"
                                        >
                                          <div className="flex justify-between items-center text-[9px] font-bold text-[var(--text-main)] ">
                                            <span className="truncate max-w-[120px]">
                                              🔗 {sub.name}
                                            </span>
                                            <span className="px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-600 text-[7px] font-black uppercase font-mono">
                                              {sub.role || "auxiliary"}
                                            </span>
                                          </div>
                                          <div className="grid grid-cols-2 gap-1 text-[8px] text-[var(--text-muted)] ">
                                            <div>Type: {sub.type}</div>
                                            <div>
                                              Bounds: {sub.bounding.w}x
                                              {sub.bounding.h}
                                              {""}
                                              px
                                            </div>
                                          </div>
                                          {sub.asset ? (
                                            <div className="flex justify-between items-center text-[8px] pt-1 border-t border-[var(--border-subtle)] dark:border-t-white/[0.06] text-[var(--text-muted)] ">
                                              <span className="font-mono">
                                                Asset:{" "}
                                                {sub.asset.id.slice(0, 8)}
                                              </span>
                                              <span className="font-bold text-indigo-650 ">
                                                {formatBytes(sub.asset.size)}
                                              </span>
                                            </div>
                                          ) : (
                                            <div className="text-[7px] text-[var(--text-muted)] ">
                                              No Asset Bound
                                            </div>
                                          )}
                                        </div>
                                      ),
                                    )}
                                  </div>
                                </div>
                              )}

                            {/* EXIF Data Panel */}
                            {selectedNode.data.exif && (
                              <div className="mt-4 pt-4 border-t border-[var(--border-subtle)] dark:border-t-white/[0.06] space-y-1.5">
                                <div className="text-[8px] font-black uppercase text-[var(--text-muted)] ">
                                  EXIF Meta Profile
                                </div>
                                {selectedNode.data.exif.Make && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>Camera Make</span>
                                    <span className="text-[var(--text-main)] ">
                                      {selectedNode.data.exif.Make}
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.Model && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>Camera Model</span>
                                    <span className="text-[var(--text-main)] truncate max-w-[130px]">
                                      {selectedNode.data.exif.Model}
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.DateTimeOriginal && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>DateTime</span>
                                    <span className="text-[var(--text-main)] truncate max-w-[130px]">
                                      {selectedNode.data.exif.DateTimeOriginal}
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.LensModel && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>Lens Model</span>
                                    <span className="text-[var(--text-main)] truncate max-w-[130px]">
                                      {selectedNode.data.exif.LensModel}
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.ExposureTime && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>Shutter Speed</span>
                                    <span className="text-[var(--text-main)] ">
                                      {selectedNode.data.exif.ExposureTime}s
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.FNumber && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>Aperture Value</span>
                                    <span className="text-[var(--text-main)] ">
                                      f/{selectedNode.data.exif.FNumber}
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.ISOSpeedRatings && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>ISO Rating</span>
                                    <span className="text-[var(--text-main)] ">
                                      {selectedNode.data.exif.ISOSpeedRatings}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Asset Attributes */}
                        {selectedNode.type === "asset" && (
                          <div className="space-y-2">
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                HASH SHA-256
                              </span>
                              <span className="text-[var(--text-main)] truncate max-w-[160px]">
                                {selectedNode.data.id}
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                RAW SIZE
                              </span>
                              <span className="text-indigo-600 font-bold">
                                {formatBytes(selectedNode.data.size)}
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                MIME-TYPE
                              </span>
                              <span className="text-[var(--text-main)] truncate max-w-[150px]">
                                {selectedNode.data.type}
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                REF COUNT
                              </span>
                              <span className="text-emerald-600 font-bold">
                                {selectedNode.data.refCount} Owners
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                TAGS
                              </span>
                              <span className="text-[var(--text-main)] ">
                                {selectedNode.data.tags.join(",") || "none"}
                              </span>
                            </div>

                            {selectedNode.data.tileMeta && (
                              <div className="mt-4 pt-4 border-t border-[var(--border-subtle)] dark:border-t-white/[0.06] space-y-2">
                                <div className="text-[8px] font-black uppercase text-[var(--text-muted)] ">
                                  Decoding Tile Meta
                                </div>
                                <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                                  <span className="text-[var(--text-muted)] ">
                                    RESOLUTION
                                  </span>
                                  <span className="text-[var(--text-main)] font-bold">
                                    {selectedNode.data.tileMeta.width} x{""}
                                    {selectedNode.data.tileMeta.height} px
                                  </span>
                                </div>
                                <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                                  <span className="text-[var(--text-muted)] ">
                                    COLUMNS / ROWS
                                  </span>
                                  <span className="text-[var(--text-main)] ">
                                    {selectedNode.data.tileMeta.cols ??
                                      Math.ceil(
                                        selectedNode.data.tileMeta.width / 256,
                                      )}
                                    {""}x{""}
                                    {selectedNode.data.tileMeta.rows ??
                                      Math.ceil(
                                        selectedNode.data.tileMeta.height / 256,
                                      )}
                                    {""}
                                    tiles
                                  </span>
                                </div>
                              </div>
                            )}

                            <div className="mt-4 pt-4 border-t border-[var(--border-subtle)] dark:border-t-white/[0.06] flex gap-2">
                              <button
                                onClick={() =>
                                  copyAssetUsages(selectedNode.data)
                                }
                                className="flex-1 py-1.5 px-3 rounded-lg bg-indigo-550/10 hover border border-indigo-200 text-indigo-600 font-bold text-[8px] font-black uppercase tracking-wider text-center"
                              >
                                Copy Usages
                              </button>
                            </div>
                          </div>
                        )}

                        {/* History moment Attributes */}
                        {selectedNode.type === "history" && (
                          <div className="space-y-2">
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                MOMENT ID
                              </span>
                              <span className="text-[var(--text-main)] truncate max-w-[160px]">
                                {selectedNode.data.id}
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                TIME DIFFERENCE
                              </span>
                              <span className="text-[var(--text-main)] ">
                                Momentary save
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                TOTAL ASSETS
                              </span>
                              <span className="text-[var(--text-main)] ">
                                {selectedNode.data.assets.length} Assets
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                SNAPSHOT WEIGHT
                              </span>
                              <span className="text-indigo-650 font-bold">
                                {formatBytes(selectedNode.data.totalSize)}
                              </span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] ">
                              <span className="text-[var(--text-muted)] ">
                                EXCLUSIVE WASTE
                              </span>
                              <span
                                className={
                                  selectedNode.data.exclusiveSize > 0
                                    ? "text-amber-600 font-bold"
                                    : "text-emerald-600 "
                                }
                              >
                                {formatBytes(selectedNode.data.exclusiveSize)}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-center opacity-30 px-4">
                      <Database
                        size={24}
                        className="mb-2 text-[var(--text-muted)] "
                      />
                      <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] ">
                        Storage Inspector
                      </div>
                      <div className="text-[8px] mt-1 font-mono leading-relaxed text-[var(--text-muted)] ">
                        Select any topology node in the tree explorer to audit
                        properties and EXIF metadata.
                      </div>
                    </div>
                  )}

                  {/* Dynamic asset hover card */}
                  {hoveredAsset && (
                    <div className="absolute bottom-6 left-6 right-6 p-3 rounded-2xl bg-[var(--bg-panel)] border border-[var(--border-subtle)] dark:border-white/[0.08] shadow-3xl flex flex-col gap-2 font-mono text-[8px] animate-in fade-in slide-in-from-bottom-2 duration-200 text-[var(--text-main)] ">
                      <div className="text-[7px] font-black uppercase text-[var(--text-muted)] leading-none">
                        Live Asset Preview
                      </div>

                      <div className="w-full h-24 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] overflow-hidden flex items-center justify-center">
                        <img
                          src={hoveredAsset.url}
                          alt=""
                          className="max-w-full max-h-full object-contain"
                        />
                      </div>

                      <div className="flex justify-between leading-none text-[var(--text-main)] mt-1">
                        <span className="truncate max-w-[140px]">
                          {hoveredAsset.type.split("/")[1]?.toUpperCase() ||
                            "RAW"}
                        </span>
                        <span className="font-bold text-indigo-600 ">
                          {formatBytes(hoveredAsset.size)}
                        </span>
                      </div>
                      <div className="text-[7px] text-[var(--text-muted)] leading-none truncate">
                        {hoveredAsset.id}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </PopupPanel>
  );
});

/**
 * StorageInfoSettings: Switch switch configuration contributed to Settings pane
 */
export function StorageInfoSettings() {
  const { isEnabled, toggleCmd } = useStorageConfig();

  return (
    <>
      <FunctionButton
        title="Storage Visualization"
        active={isEnabled}
        onClick={() => toggleCmd?.execute()}
      >
        <Package size={14} />
      </FunctionButton>
    </>
  );
}
