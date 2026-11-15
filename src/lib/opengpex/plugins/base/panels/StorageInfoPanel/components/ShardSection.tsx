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

import React, { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import * as Prot from "../protocols";
import { formatBytes } from "./shared";

interface ShardSectionProps {
  shards: Prot.DBShardMetric[];
  stateBytes: number;
}

/**
 * IndexedDB shard metrics section for the left dashboard column
 */
export function ShardSection({ shards, stateBytes }: ShardSectionProps) {
  // Collapsed by default: the shard list is reference data, not a headline metric.
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-3 bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] p-4 rounded-2xl">
      <div
        onClick={() => setExpanded((v) => !v)}
        className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] flex items-center justify-between cursor-pointer select-none"
      >
        <span className="flex items-center gap-1.5">
          {expanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
          Store Shard Index
        </span>
        <span className="font-mono text-[9px] text-[var(--text-muted)] whitespace-nowrap">
          {formatBytes(stateBytes)} / {shards.length} shards
        </span>
      </div>

      {expanded && (
      <div className="space-y-1.5 text-[9px] font-mono">
        {shards.map((shard) => (
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
      )}
    </div>
  );
}
