/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

"use client";

import React from "react";
import { Trash2, ChevronRight, ChevronDown } from "lucide-react";
import * as Prot from "../protocols";
import { formatBytes } from "./shared";

interface AssetSectionHUDProps {
  detached: Prot.AssetMetric[];
}

/**
 * Detached assets section for HUD (compact) mode
 */
export function AssetSectionHUD({ detached }: AssetSectionHUDProps) {
  if (detached.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 pl-1 text-rose-500 opacity-80">
        <Trash2 size={10} />
        <span className="text-[9px] font-black uppercase tracking-widest">
          Detached Trash ({detached.length})
        </span>
      </div>
      <div className="bg-rose-500/5 rounded-xl border border-rose-500/20 p-2 text-[9px] space-y-1">
        {detached.slice(0, 3).map((asset) => (
          <div
            key={asset.id}
            className="flex justify-between items-center text-rose-500 opacity-80"
          >
            <span className="truncate max-w-[150px] font-mono">
              {asset.id.slice(0, 12)}
            </span>
            <span className="font-mono">{formatBytes(asset.size)}</span>
          </div>
        ))}
        {detached.length > 3 && (
          <div className="text-[8px] opacity-60 text-center pt-1 text-rose-500">
            + {detached.length - 3} more orphans
          </div>
        )}
      </div>
    </div>
  );
}

interface AssetTreeNodeProps {
  detached: Prot.AssetMetric[];
  expandedNodes: Record<string, boolean>;
  selectedNodeId: string | null;
  toggleNode: (key: string) => void;
  setSelectedNode: (node: { type: "frame" | "layer" | "asset" | "history"; id: string; data: unknown } | null) => void;
  setHoveredAsset: (asset: Prot.AssetMetric | null) => void;
}

/**
 * Detached assets tree node for expanded dashboard mode
 */
export function AssetTreeNode({
  detached,
  expandedNodes,
  selectedNodeId,
  toggleNode,
  setSelectedNode,
  setHoveredAsset,
}: AssetTreeNodeProps) {
  return (
    <div className="flex flex-col">
      <div
        onClick={() => toggleNode("detached")}
        className="flex items-center gap-2 py-1 px-2 rounded-lg hover cursor-pointer text-[var(--text-main)] font-bold transition-colors"
      >
        {expandedNodes.detached ? (
          <ChevronDown size={11} className="text-[var(--text-muted)]" />
        ) : (
          <ChevronRight size={11} className="text-[var(--text-muted)]" />
        )}
        <Trash2 size={11} className="text-rose-500 " />
        <span>
          global-detached-cache ({detached.length} orphans)
        </span>
      </div>

      {expandedNodes.detached && (
        <div className="pl-4 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-3.5 space-y-1 mt-0.5">
          {detached.map((asset) => (
            <div
              key={asset.id}
              onClick={() => setSelectedNode({ type: "asset", id: asset.id, data: asset })}
              onMouseEnter={() => setHoveredAsset(asset)}
              onMouseLeave={() => setHoveredAsset(null)}
              className={`flex justify-between items-center py-0.5 px-2 rounded hover cursor-pointer ${selectedNodeId === asset.id ? "bg-rose-500/10 text-rose-500 font-bold" : "text-[var(--text-muted)]"}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                <span className="truncate font-mono">{asset.id.slice(0, 14)}</span>
              </div>
              <span className="font-mono text-[8px] text-[var(--text-muted)] ">
                {formatBytes(asset.size)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
