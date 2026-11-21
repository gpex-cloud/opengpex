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
  Cpu,
  AlertCircle,
  Package,
  Brain,
  HardDrive,
} from "lucide-react";
import {
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import { Hydrating } from "@opengpex/editor/core/storage/state/Hydrating";
import { PopupPanel } from "@opengpex/editor/widgets/PopupPanel";
import {
  useStorageMetrics,
  useStorageConfig,
  useModelCacheMetrics,
  purgeModelCacheStorage,
} from "./hooks";
import * as Prot from "./protocols";
import { formatBytes } from "./components/shared";
import { FrameSectionHUD, FrameTreeNodes } from "./components/FrameSection";
import { AssetSectionHUD, AssetTreeNode } from "./components/AssetSection";
import { HistoryTreeNode } from "./components/HistorySection";
import { ShardSection } from "./components/ShardSection";
import { ModelCacheTreeNode } from "./components/ModelCacheSection";
import { StoreAuditHUD, StoreAuditTreeNode, StoreAuditDetails } from "./components/StoreAuditSection";

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
    storage.gc(stateRef.current, true);
    refresh();
  }, [storage, refresh]);

  const clearHistory = useCallback(() => {
    actions.history.purge();
    // Immediately reclaim orphaned assets that were only referenced by history
    storage.gc(stateRef.current, true);
    refresh();
  }, [actions.history, storage, refresh]);

  const purgeAll = useCallback(async () => {
    // Clear AI model cache from Cache Storage
    await purgeModelCacheStorage();
    await storage.clear();
    await assets.clear();
    window.location.reload();
  }, [storage, assets]);

  const purgeOrphans = useCallback(async () => {
    // Authoritative referenced set derived from the CURRENT state (frames +
    // history) — the same authority the GC sweep uses; AssetService applies
    // over-broad protection on top.
    const referenced = Hydrating.extractAllIds(stateRef.current);
    const { removed, bytes } = await assets.purgeOrphans(referenced);
    if (removed > 0) {
      console.info(`[StorageInfo] Purged ${removed} orphaned store entries (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    }
    refresh();
  }, [assets, refresh]);

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
      purgeAll={purgeAll}
      purgeOrphans={purgeOrphans}
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
  purgeAll: () => Promise<void>;
  purgeOrphans: () => Promise<void>;
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
  purgeAll,
  purgeOrphans,
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
    type: "frame" | "layer" | "asset" | "history" | "store";
    id: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any;
  } | null>(null);

  // Active hover preview card for assets
  const [hoveredAsset, setHoveredAsset] = useState<Prot.AssetMetric | null>(null);

  // Orphan tree nodes default to EXPANDED: the orphan triage is this panel's
  // reason to exist, so its triage view must not hide behind a second click.
  const toggleNode = (nodeKey: string) => {
    setExpandedNodes((prev) => ({
      ...prev,
      [nodeKey]: prev[nodeKey] === undefined ? true : !prev[nodeKey],
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

  // ── Two accounting domains, never mixed ─────────────────────────────────
  // MEMORY — the session pool (the RAM working set THIS session hydrated):
  //   active frames' assets + pool entries held for undo (detached). The pool
  //   total is the single source; its segments partition it (every pool entry
  //   is active, detached, or the built-in system placeholder). History-only
  //   bytes are a SUBSET of detached — never an independent segment.
  // STORAGE — IndexedDB: the store audit's alive/orphan split + serialized
  //   state shards + downloaded models. The pool is NOT added here (hydrated
  //   pool assets are copies of persisted records — summing both domains
  //   would double count the same bytes).
  const detachedSize = metrics.detached.reduce((sum, a) => sum + a.size, 0);
  const memoryTotal = metrics.totalBytes;
  const memoryOtherBytes = Math.max(0, memoryTotal - activeSize - detachedSize);
  const stateSize = metrics.stateBytes || 0;
  const modelSize = modelCache.totalBytes;
  const storeAudit = metrics.storeAudit;
  const storeInUseBytes = storeAudit?.aliveBytes ?? 0;
  const storeOrphanBytes = storeAudit?.orphanBytes ?? 0;
  const storeAliveCount = storeAudit ? storeAudit.entries.length - storeAudit.orphanCount : 0;
  const storeTotal = storeInUseBytes + storeOrphanBytes + stateSize + modelSize;

  const memoryDenominator = memoryTotal || 1;
  const pMemoryActive = (activeSize / memoryDenominator) * 100;
  const pMemoryDetached = (detachedSize / memoryDenominator) * 100;
  const pMemoryOther = (memoryOtherBytes / memoryDenominator) * 100;

  const storeDenominator = storeTotal || 1;
  const pStoreInUse = (storeInUseBytes / storeDenominator) * 100;
  const pStoreOrphan = (storeOrphanBytes / storeDenominator) * 100;
  const pState = (stateSize / storeDenominator) * 100;
  const pModels = (modelSize / storeDenominator) * 100;

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
                  <Zap size={8} className="text-indigo-500" />
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
                    className={isRefreshing ? "animate-spin-lite" : ""}
                  />
                </button>
              </div>

              {/* Compact stats grid — the two accounting domains, same split
                  as the dashboard's bars (memory pool vs IndexedDB store) */}
              <div className="grid grid-cols-2 gap-2 flex-shrink-0">
                <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                  <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1">
                    MEMORY
                  </div>
                  <div className="text-sm font-mono text-[var(--text-main)] font-bold tabular-nums">
                    {formatBytes(metrics.totalBytes)}
                  </div>
                </div>
                <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                  <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1">
                    STORAGE
                  </div>
                  <div className="text-sm font-mono text-[var(--text-main)] font-bold tabular-nums">
                    {formatBytes((metrics.storeAudit?.totalBytes ?? 0) + metrics.stateBytes)}
                  </div>
                  {metrics.storeAudit && metrics.storeAudit.orphanCount > 0 && (
                    <div className="text-[8px] font-mono text-rose-500 mt-0.5">
                      orphans {metrics.storeAudit.orphanCount} · {formatBytes(metrics.storeAudit.orphanBytes)}
                    </div>
                  )}
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
                <FrameSectionHUD
                  frames={metrics.frames}
                  handleSelectFrame={handleSelectFrame}
                  handleSelectLayer={handleSelectLayer}
                />
                <AssetSectionHUD detached={metrics.detached} />
                <StoreAuditHUD storeAudit={metrics.storeAudit} />
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
              <div className="w-[380px] border-r border-[var(--border-subtle)] dark:border-r-white/[0.06] p-4 flex flex-col gap-3 overflow-y-auto bg-[var(--bg-stage)] custom-scrollbar">
                {/* MEMORY DOMAIN — session pool (RAM working set) */}
                <div className="space-y-2">
                  <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] flex items-center justify-between">
                    <span>Memory · Session Pool</span>
                    <span className="font-mono text-[var(--text-main)] font-bold">
                      {formatBytes(memoryTotal)}
                    </span>
                  </div>
                  <div className="h-3 w-full bg-[var(--bg-stage)] rounded-full overflow-hidden flex ring-1 ring-inset ring-black/5 ">
                    <div
                      style={{ width: `${pMemoryActive}%` }}
                      className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500"
                      title="Active Frame Assets"
                    />
                    <div
                      style={{ width: `${pMemoryDetached}%` }}
                      className="h-full bg-gradient-to-r from-rose-500 to-red-500 transition-all duration-500"
                      title="Detached — Held for Undo"
                    />
                    {memoryOtherBytes > 0 && (
                      <div
                        style={{ width: `${pMemoryOther}%` }}
                        className="h-full bg-gradient-to-r from-slate-400 to-slate-500 transition-all duration-500"
                        title="System Placeholder & Other Pool Entries"
                      />
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 text-[9px]">
                    <div className="flex flex-col gap-1 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                      <div className="flex items-center gap-1.5 text-[var(--text-muted)] ">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                        <span>Active Frames</span>
                      </div>
                      <span className="font-mono text-[var(--text-main)] font-bold pl-3">
                        {formatBytes(activeSize)} ({pMemoryActive.toFixed(1)}%)
                      </span>
                    </div>

                    <div className="flex flex-col gap-1 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                      <div className="flex items-center gap-1.5 text-[var(--text-muted)] ">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                        <span>Detached (Undo-Held)</span>
                      </div>
                      <span className="font-mono text-[var(--text-main)] font-bold pl-3">
                        {formatBytes(detachedSize)} ({pMemoryDetached.toFixed(1)}%)
                      </span>
                    </div>
                  </div>
                </div>

                {/* STORAGE DOMAIN — IndexedDB persistence */}
                <div className="space-y-2">
                  <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] flex items-center justify-between">
                    <span>Storage · IndexedDB</span>
                    <span className="font-mono text-[var(--text-main)] font-bold">
                      {formatBytes(storeTotal)}
                    </span>
                  </div>
                  <div className="h-3 w-full bg-[var(--bg-stage)] rounded-full overflow-hidden flex ring-1 ring-inset ring-black/5 ">
                    <div
                      style={{ width: `${pStoreInUse}%` }}
                      className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500"
                      title="Store In-Use (referenced by frames + history)"
                    />
                    <div
                      style={{ width: `${pStoreOrphan}%` }}
                      className="h-full bg-gradient-to-r from-red-700 to-rose-700 transition-all duration-500"
                      title="Store Orphans (auto-reclaimed after the age gate; Purge bypasses)"
                    />
                    <div
                      style={{ width: `${pState}%` }}
                      className="h-full bg-gradient-to-r from-sky-500 to-cyan-500 transition-all duration-500"
                      title="Database State Shards"
                    />
                    {modelSize > 0 && (
                      <div
                        style={{ width: `${pModels}%` }}
                        className="h-full bg-gradient-to-r from-purple-500 to-fuchsia-500 transition-all duration-500"
                        title="Downloaded Models (Cache Storage)"
                      />
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 text-[9px]">
                    <div className="flex flex-col gap-1 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                      <div className="flex items-center gap-1.5 text-[var(--text-muted)] ">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        <span>Store In-Use</span>
                        {storeAudit && (
                          <span className="font-mono text-[8px] text-[var(--text-muted)] ml-auto">
                            {storeAliveCount} entries
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[var(--text-main)] font-bold pl-3">
                        {formatBytes(storeInUseBytes)} ({pStoreInUse.toFixed(1)}%)
                      </span>
                    </div>

                    <div className="flex flex-col gap-1 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08]">
                      <div className="flex items-center gap-1.5 text-[var(--text-muted)] ">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-700" />
                        <span>Store Orphans</span>
                        {storeAudit && storeAudit.orphanCount > 0 && (
                          <span className="font-mono text-[8px] text-rose-500 ml-auto">
                            {storeAudit.orphanCount} entries
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[var(--text-main)] font-bold pl-3">
                        {formatBytes(storeOrphanBytes)} ({pStoreOrphan.toFixed(1)}%)
                      </span>
                    </div>

                    <div className="flex flex-col gap-1 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] ">
                      <div className="flex items-center gap-1.5 text-[var(--text-muted)] ">
                        <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
                        <span>DB State Shards</span>
                      </div>
                      <span className="font-mono text-[var(--text-main)] font-bold pl-3">
                        {formatBytes(stateSize)} ({pState.toFixed(1)}%)
                      </span>
                    </div>

                    <div className="flex flex-col gap-1 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08]">
                      <div className="flex items-center gap-1.5 text-[var(--text-muted)] ">
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
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
                <ShardSection shards={metrics.shards} stateBytes={metrics.stateBytes} />

                {/* Performance Indicators */}
                <div className="space-y-3 mt-3">
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
                  {/* Data Management — Force GC first (non-destructive reclaim),
                      then the destructive purge menu (DelayedConfirm per row).
                      Every entry carries a DelayedConfirm window inside the
                      dropdown row itself; the menu opens UP because the panel
                      docks to the bottom-right corner. */}
                  <div className="space-y-2 p-3 rounded-xl border border-[var(--border-subtle)] dark:border-white/[0.08] bg-[var(--bg-stage)]">
                    <div className="text-[8px] font-black uppercase tracking-widest text-[var(--text-muted)]">
                      Data Management
                    </div>
                    <div className="flex flex-wrap gap-2">
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
                      <ActionDropdown
                      align="right"
                      direction="up"
                      trigger={
                        <button
                          onMouseDown={(e) => e.preventDefault()}
                          className="flex items-center gap-1 px-2 h-7 rounded-full border border-rose-500/30 bg-rose-500/5 text-rose-500 text-[9px] font-black uppercase tracking-wider hover:bg-rose-500/15 transition-colors"
                        >
                          <Trash2 size={10} />
                          Purge
                          <ChevronDown size={8} className="opacity-50" />
                        </button>
                      }
                      onSelect={(value) => {
                        if (value === 'orphans') void purgeOrphans();
                        else if (value === 'history') void clearHistory();
                        else if (value === 'models') void purgeDownloadedModels();
                        else if (value === 'wipe') void purgeAll();
                      }}
                      options={[
                        {
                          label: 'Store Orphans',
                          value: 'orphans',
                          description:
                            metrics.storeAudit && metrics.storeAudit.orphanCount > 0
                              ? `${metrics.storeAudit.orphanCount} · ${formatBytes(metrics.storeAudit.orphanBytes)}`
                              : 'none',
                          icon: <HardDrive size={11} />,
                          variant: 'warning',
                          confirm: 2000,
                        },
                        {
                          label: 'Undo History',
                          value: 'history',
                          icon: <History size={11} />,
                          variant: 'warning',
                          confirm: 2000,
                        },
                        ...(modelCache.totalBytes > 0
                          ? [{
                              label: 'AI Models',
                              value: 'models',
                              icon: <Brain size={11} />,
                              variant: 'warning' as const,
                              confirm: 2000,
                            }]
                          : []),
                        { label: '', value: 'divider', divider: true },
                        {
                          label: 'Wipe All Data',
                          value: 'wipe',
                          description: 'everything',
                          icon: <Trash2 size={11} />,
                          variant: 'danger',
                          confirm: 3000,
                        },
                      ]}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Column - Topology Tree Explorer & Detail Pane */}
              <div className="flex-1 flex min-w-0">
                {/* Tree Section */}
                <div className="flex-1 overflow-y-auto p-4 pt-2 min-w-0 scrollbar-hide space-y-2">
                  <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] flex items-center justify-between">
                    <span>Resource Topology tree</span>
                    <button
                      onClick={refresh}
                      disabled={isRefreshing}
                      title="Refresh tree"
                      className="p-1 rounded-md transition-all hover:bg-[var(--bg-stage)] hover:text-[var(--text-main)] disabled:opacity-40"
                    >
                      <RefreshCw size={12} className={isRefreshing ? "animate-spin-lite" : ""} />
                    </button>
                  </div>

                  {/* Dynamic Interactive Tree Outline */}
                  <div className="space-y-1 select-none font-mono text-[10px] -mx-2">
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
                        <div className="pl-2 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-2.5 mt-0.5 space-y-1">
                          <FrameTreeNodes
                            frames={metrics.frames}
                            expandedNodes={expandedNodes}
                            selectedNodeId={selectedNode?.id || null}
                            toggleNode={toggleNode}
                            handleSelectFrame={handleSelectFrame}
                            handleSelectLayer={handleSelectLayer}
                            setSelectedNode={setSelectedNode}
                            setHoveredAsset={setHoveredAsset}
                          />
                          <HistoryTreeNode
                            history={metrics.history}
                            expandedNodes={expandedNodes}
                            selectedNodeId={selectedNode?.id || null}
                            toggleNode={toggleNode}
                            setSelectedNode={setSelectedNode}
                          />
                          <AssetTreeNode
                            detached={metrics.detached}
                            expandedNodes={expandedNodes}
                            selectedNodeId={selectedNode?.id || null}
                            toggleNode={toggleNode}
                            setSelectedNode={setSelectedNode}
                            setHoveredAsset={setHoveredAsset}
                          />
                          <StoreAuditTreeNode
                            storeAudit={metrics.storeAudit}
                            expandedNodes={expandedNodes}
                            selectedNodeId={selectedNode?.id || null}
                            toggleNode={toggleNode}
                            setSelectedNode={setSelectedNode}
                          />
                          <ModelCacheTreeNode
                            modelCache={modelCache}
                            expandedNodes={expandedNodes}
                            toggleNode={toggleNode}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Details Inspector Pane (Right Part of Tree Explorer) */}
                <div className="w-[300px] border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] p-4 flex flex-col gap-5 overflow-y-auto bg-[var(--bg-stage)] custom-scrollbar relative select-none">
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
                                {Math.round(selectedNode.data.opacity * 100)} %
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
                            {selectedNode.data.exif && (selectedNode.data.exif.camera || selectedNode.data.exif.capture || selectedNode.data.exif.dates) && (
                              <div className="mt-4 pt-4 border-t border-[var(--border-subtle)] dark:border-t-white/[0.06] space-y-1.5">
                                <div className="text-[8px] font-black uppercase text-[var(--text-muted)] ">
                                  EXIF Meta Profile
                                </div>
                                {selectedNode.data.exif.camera?.make && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>Camera Make</span>
                                    <span className="text-[var(--text-main)] ">
                                      {selectedNode.data.exif.camera.make}
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.camera?.model && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>Camera Model</span>
                                    <span className="text-[var(--text-main)] truncate max-w-[130px]">
                                      {selectedNode.data.exif.camera.model}
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.dates?.created && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>DateTime</span>
                                    <span className="text-[var(--text-main)] truncate max-w-[130px]">
                                      {selectedNode.data.exif.dates.created}
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.camera?.lensModel && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>Lens Model</span>
                                    <span className="text-[var(--text-main)] truncate max-w-[130px]">
                                      {selectedNode.data.exif.camera.lensModel}
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.capture?.exposureTime && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>Shutter Speed</span>
                                    <span className="text-[var(--text-main)] ">
                                      {selectedNode.data.exif.capture.exposureTime}s
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.capture?.fNumber && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>Aperture Value</span>
                                    <span className="text-[var(--text-main)] ">
                                      f/{selectedNode.data.exif.capture.fNumber}
                                    </span>
                                  </div>
                                )}
                                {selectedNode.data.exif.capture?.iso && (
                                  <div className="flex justify-between py-0.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] text-[var(--text-muted)] ">
                                    <span>ISO Rating</span>
                                    <span className="text-[var(--text-main)] ">
                                      {selectedNode.data.exif.capture.iso}
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

                          </div>
                        )}

                        {/* Store entry (IndexedDB audit) Attributes */}
                        {selectedNode.type === "store" && (
                          <StoreAuditDetails entry={selectedNode.data as Prot.StoreAuditEntryView} />
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
      <FancyButton iconOnly shape="rect"
        title="Storage Visualization"
        active={isEnabled}
        onClick={() => toggleCmd?.execute()}
      >
        <Package size={14} />
      </FancyButton>
    </>
  );
}
