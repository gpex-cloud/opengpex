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
import { Brain, ChevronRight, ChevronDown, Package } from "lucide-react";
import type { ModelCacheInfo } from "../hooks";
import { formatBytes } from "./shared";

interface ModelCacheTreeNodeProps {
  modelCache: ModelCacheInfo;
  expandedNodes: Record<string, boolean>;
  toggleNode: (key: string) => void;
}

/**
 * Downloaded models tree node for expanded dashboard mode
 */
export function ModelCacheTreeNode({
  modelCache,
  expandedNodes,
  toggleNode,
}: ModelCacheTreeNodeProps) {
  return (
    <div className="flex flex-col">
      <div
        onClick={() => toggleNode("models")}
        className="flex items-center gap-2 py-1 px-2 rounded-lg hover cursor-pointer text-[var(--text-main)] font-bold transition-colors"
      >
        {expandedNodes.models ? (
          <ChevronDown size={11} className="text-[var(--text-muted)]" />
        ) : (
          <ChevronRight size={11} className="text-[var(--text-muted)]" />
        )}
        <Brain size={11} className="text-purple-500 " />
        <span>
          downloaded-models ({modelCache.fileCount} files)
        </span>
      </div>

      {expandedNodes.models && (
        <div className="pl-4 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-3.5 space-y-1 mt-0.5">
          {modelCache.groups.length > 0 ? (
            <>
              {modelCache.groups.map((group) => {
                const groupKey = `model:${group.modelId}`;
                const isGroupExpanded = expandedNodes[groupKey] === true;
                return (
                  <div key={group.modelId} className="flex flex-col">
                    <div
                      onClick={() => toggleNode(groupKey)}
                      className="flex justify-between items-center py-0.5 px-2 rounded hover cursor-pointer text-[var(--text-muted)]"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {isGroupExpanded ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                        <Package size={9} className="text-purple-400" />
                        <span className="truncate text-[9px] font-bold">
                          {group.modelId}
                        </span>
                      </div>
                      <span className="font-mono text-[8px] text-purple-500 font-bold flex-shrink-0 ml-2">
                        {formatBytes(group.totalBytes)}
                      </span>
                    </div>
                    {isGroupExpanded && (
                      <div className="pl-4 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-2.5 space-y-0.5 mt-0.5">
                        {group.files.map((file, idx) => (
                          <div
                            key={`${group.modelId}-${idx}`}
                            className="flex justify-between items-center py-0.5 px-1.5 text-[var(--text-muted)]"
                            title={file.url}
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="w-1 h-1 rounded bg-purple-300" />
                              <span className="truncate text-[9px] font-mono">
                                {file.name}
                              </span>
                            </div>
                            <span className="font-mono text-[8px] text-[var(--text-muted)] flex-shrink-0 ml-2">
                              {formatBytes(file.size)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          ) : (
            <div className="py-1 px-2 text-[var(--text-muted)] text-[9px] opacity-60">
              No models downloaded yet
            </div>
          )}
        </div>
      )}
    </div>
  );
}
