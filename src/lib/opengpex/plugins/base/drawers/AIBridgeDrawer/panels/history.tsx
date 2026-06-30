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
import { Download, Trash2, Clock, CheckCircle2, XCircle, Copy, Check } from "lucide-react";
import { usePluginSelfConfig } from "@opengpex/editor/core/context";
import { GenerationRecord } from "../protocols";

interface HistoryConfig {
  generationHistory?: GenerationRecord[];
}

/**
 * AIBridgeHistory: Generation history panel
 * Displays metadata list of all generation history, providing text download function.
 */
export function AIBridgeHistory() {
  const [config, setConfig] = usePluginSelfConfig<HistoryConfig>();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const history: GenerationRecord[] = config.generationHistory || [];

  const clearHistory = () => {
    setConfig({ generationHistory: [] });
  };

  const deleteRecord = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = history.filter((r) => r.id !== id);
    setConfig({ generationHistory: updated });
  };

  const copyRecord = (record: GenerationRecord, e: React.MouseEvent) => {
    e.stopPropagation();
    const date = new Date(record.timestamp).toLocaleString();
    const status = record.success ? "✓ SUCCESS" : "✗ FAILED";
    const lines = [
      `[${date}] ${status}`,
      `Provider: ${record.provider} | Model: ${record.model}`,
      `Mode: ${record.mode} | Size: ${record.size} | Seed: ${record.seed}`,
      `Duration: ${record.durationMs}ms`,
      `Prompt: ${record.prompt}`,
      record.negativePrompt ? `Negative: ${record.negativePrompt}` : null,
      record.error ? `Error: ${record.error}` : null,
    ].filter(Boolean).join("\n");
    navigator.clipboard.writeText(lines).then(() => {
      setCopiedId(record.id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  const downloadHistory = () => {
    if (history.length === 0) return;

    const lines = history.map((r) => {
      const date = new Date(r.timestamp).toLocaleString();
      const status = r.success ? "✓ SUCCESS" : "✗ FAILED";
      return [
        `─────────────────────────────────────────`,
        `[${date}] ${status}`,
        `Provider: ${r.provider} | Model: ${r.model}`,
        `Mode: ${r.mode} | Size: ${r.size} | Seed: ${r.seed}`,
        `Duration: ${r.durationMs}ms`,
        `Prompt: ${r.prompt}`,
        r.negativePrompt ? `Negative: ${r.negativePrompt}` : null,
        r.error ? `Error: ${r.error}` : null,
      ].filter(Boolean).join("\n");
    });

    const content = [
      `AI Generation History`,
      `Exported: ${new Date().toLocaleString()}`,
      `Total Records: ${history.length}`,
      ``,
      ...lines,
      `─────────────────────────────────────────`,
    ].join("\n");

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ai-generation-history-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
        <Clock size={24} className="text-[var(--text-muted)] mb-3 opacity-40" />
        <p className="text-[10px] font-bold text-[var(--text-muted)] mb-1">
          No Generation History
        </p>
        <p className="text-[9px] text-[var(--text-muted)] opacity-60">
          Records will appear here after you generate images.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header actions */}
      <div className="flex items-center justify-between px-1">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest">
          {history.length} Record{history.length > 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={downloadHistory}
            className="flex items-center gap-1 text-[9px] font-bold text-blue-400 hover:text-blue-400 transition-colors uppercase tracking-wider"
            title="Download as text file"
          >
            <Download size={10} /> Export
          </button>
          <button
            onClick={clearHistory}
            className="flex items-center gap-1 text-[9px] font-bold text-rose-500 hover:text-rose-400 transition-colors uppercase tracking-wider"
            title="Clear all history"
          >
            <Trash2 size={10} /> Clear
          </button>
        </div>
      </div>

      {/* Records list */}
      <div className="flex flex-col gap-1.5 max-h-[400px] overflow-y-auto pr-1">
        {history.slice().reverse().map((record) => {
          const isExpanded = expandedId === record.id;
          const date = new Date(record.timestamp);
          const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });

          return (
            <div
              key={record.id}
              className={`rounded-lg border transition-all cursor-pointer group/record ${
                record.success
                  ? "bg-[var(--bg-stage)] border-[var(--border-subtle)] hover:border-emerald-500/30"
                  : "bg-rose-500/5 border-rose-500/20 hover:border-rose-500/40"
              }`}
              onClick={() => setExpandedId(isExpanded ? null : record.id)}
            >
              {/* Compact row */}
              <div className="flex items-center gap-2 px-2.5 py-2">
                {record.success ? (
                  <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                ) : (
                  <XCircle size={11} className="text-rose-500 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[9px] font-bold text-[var(--text-main)] truncate">
                    {record.prompt || "(no prompt)"}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[8px] text-[var(--text-muted)] font-mono">
                    {record.model}
                  </span>
                  <span className="text-[8px] text-[var(--text-muted)]">
                    {dateStr} {timeStr}
                  </span>
                  <button
                    onClick={(e) => copyRecord(record, e)}
                    className="p-0.5 text-[var(--text-muted)] hover:text-blue-400 transition-colors opacity-0 group-hover/record:opacity-100 focus:outline-none"
                    title="Copy record info"
                  >
                    {copiedId === record.id ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} />}
                  </button>
                  <button
                    onClick={(e) => deleteRecord(record.id, e)}
                    className="p-0.5 text-[var(--text-muted)] hover:text-rose-500 transition-colors opacity-0 group-hover/record:opacity-100 focus:outline-none"
                    title="Delete record"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div className="px-2.5 pb-2.5 pt-0 border-t border-[var(--border-subtle)] mt-0">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2">
                    <DetailRow label="Provider" value={record.provider} />
                    <DetailRow label="Model" value={record.model} />
                    <DetailRow label="Mode" value={record.mode} />
                    <DetailRow label="Size" value={record.size} />
                    <DetailRow label="Seed" value={String(record.seed)} />
                    <DetailRow label="Duration" value={`${record.durationMs}ms`} />
                  </div>
                  {record.prompt && (
                    <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                      <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
                        Prompt
                      </span>
                      <p className="text-[9px] text-[var(--text-main)] mt-0.5 leading-relaxed break-words">
                        {record.prompt}
                      </p>
                    </div>
                  )}
                  {record.negativePrompt && (
                    <div className="mt-1.5">
                      <span className="text-[8px] font-black text-rose-500/80 uppercase tracking-tight">
                        Negative
                      </span>
                      <p className="text-[9px] text-[var(--text-main)] mt-0.5 leading-relaxed break-words">
                        {record.negativePrompt}
                      </p>
                    </div>
                  )}
                  {record.error && (
                    <div className="mt-1.5 px-2 py-1.5 bg-rose-500/10 rounded-md">
                      <span className="text-[8px] font-black text-rose-500 uppercase tracking-tight">
                        Error
                      </span>
                      <p className="text-[8px] text-rose-500 mt-0.5 break-words">
                        {record.error}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0">
        {label}
      </span>
      <span className="text-[9px] text-[var(--text-main)] font-mono truncate">
        {value}
      </span>
    </div>
  );
}
