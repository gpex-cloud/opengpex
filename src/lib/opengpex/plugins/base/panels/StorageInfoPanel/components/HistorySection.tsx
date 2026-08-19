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
import { History, ChevronRight, ChevronDown } from "lucide-react";
import * as Prot from "../protocols";
import { formatBytes } from "./shared";

interface HistoryTreeNodeProps {
  history: Prot.HistoryMoment[];
  expandedNodes: Record<string, boolean>;
  selectedNodeId: string | null;
  toggleNode: (key: string) => void;
  setSelectedNode: (node: { type: "frame" | "layer" | "asset" | "history"; id: string; data: unknown } | null) => void;
}

/**
 * History backlog tree node for expanded dashboard mode
 */
export function HistoryTreeNode({
  history,
  expandedNodes,
  selectedNodeId,
  toggleNode,
  setSelectedNode,
}: HistoryTreeNodeProps) {
  return (
    <div className="flex flex-col">
      <div
        onClick={() => toggleNode("history")}
        className="flex items-center gap-2 py-1 px-2 rounded-lg hover cursor-pointer text-[var(--text-main)] font-bold transition-colors"
      >
        {expandedNodes.history ? (
          <ChevronDown size={11} className="text-[var(--text-muted)]" />
        ) : (
          <ChevronRight size={11} className="text-[var(--text-muted)]" />
        )}
        <History size={11} className="text-amber-500 " />
        <span>
          history-backlog ({history.length} snapshots)
        </span>
      </div>

      {expandedNodes.history && (
        <div className="pl-4 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-3.5 space-y-1 mt-0.5">
          {history.map((moment) => (
            <div
              key={moment.id}
              onClick={() => setSelectedNode({ type: "history", id: moment.id, data: moment })}
              className={`flex justify-between items-center py-0.5 px-2 rounded hover cursor-pointer ${selectedNodeId === moment.id ? "bg-amber-500/10 text-amber-500 font-bold" : "text-[var(--text-muted)]"}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                <span className="truncate">{moment.label}</span>
              </div>
              <span className="font-mono text-[8px] text-[var(--text-muted)] ">
                {formatBytes(moment.exclusiveSize)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
