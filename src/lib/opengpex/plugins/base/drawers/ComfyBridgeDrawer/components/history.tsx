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

'use client';

import React, { useState } from 'react';
import { Download, Trash2, Clock, CheckCircle2, XCircle, MinusCircle, Copy, Check, RotateCcw } from 'lucide-react';
import type { ExecutionRecord } from '../protocols';

// ─── History Panel (full-page style, matches AIBridgeDrawer pattern) ───────────

export interface ComfyBridgeHistoryProps {
  /** All execution history records (newest first) */
  history: ExecutionRecord[];
  /** Whether the target workflow still exists (for reuse button) */
  workflows: { id: string }[];
  /** Reuse params from a history record */
  onReuseParams: (record: ExecutionRecord) => void;
  /** Export all history as JSON file */
  onExportHistory: () => void;
  /** Clear all history */
  onClearHistory: () => void;
  /** Delete a single record */
  onDeleteRecord: (id: string) => void;
}

/**
 * ComfyBridgeHistory: Full history panel (replaces main content when tab = "history").
 *
 * Mirrors AIBridgeDrawer's history panel:
 * - Header: record count + Export + Clear
 * - Expandable records list with status icon, workflow name, time, copy/delete
 * - Expanded details: params grid, prompt, error
 * - "Reuse Params" button for non-failed runs
 */
export function ComfyBridgeHistory({ history, workflows, onReuseParams, onExportHistory, onClearHistory, onDeleteRecord }: ComfyBridgeHistoryProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyRecord = (record: ExecutionRecord, e: React.MouseEvent) => {
    e.stopPropagation();
    const date = new Date(record.timestamp).toLocaleString();
    const status = record.status === 'success' ? '✓ SUCCESS' : record.status === 'cancelled' ? '− CANCELLED' : '✗ FAILED';
    const lines = [
      `[${date}] ${status}`,
      `Workflow: ${record.workflowName} | Mode: ${record.mode}`,
      `Env: ${record.envName}`,
      record.seed != null ? `Seed: ${record.seed}` : null,
      record.durationMs != null ? `Duration: ${record.durationMs}ms` : null,
      record.positivePrompt ? `Prompt: ${record.positivePrompt}` : null,
      record.error ? `Error: ${record.error}` : null,
    ].filter(Boolean).join('\n');
    navigator.clipboard.writeText(lines).then(() => {
      setCopiedId(record.id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  const deleteRecord = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onDeleteRecord(id);
  };

  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
        <Clock size={24} className="text-[var(--text-muted)] mb-3 opacity-40" />
        <p className="text-[10px] font-bold text-[var(--text-muted)] mb-1">
          No Execution History
        </p>
        <p className="text-[9px] text-[var(--text-muted)] opacity-60">
          Records will appear here after you run workflows.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header actions */}
      <div className="flex items-center justify-between px-1">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest">
          {history.length} Record{history.length > 1 ? 's' : ''}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={onExportHistory}
            className="flex items-center gap-1 text-[9px] font-bold text-blue-400 hover:text-blue-300 transition-colors uppercase tracking-wider"
            title="Download as JSON file"
          >
            <Download size={10} /> Export
          </button>
          <button
            onClick={onClearHistory}
            className="flex items-center gap-1 text-[9px] font-bold text-rose-500 hover:text-rose-400 transition-colors uppercase tracking-wider"
            title="Clear all history"
          >
            <Trash2 size={10} /> Clear
          </button>
        </div>
      </div>

      {/* Records list */}
      <div className="flex flex-col gap-1.5 max-h-[400px] overflow-y-auto pr-1">
        {history.map((record) => {
          const isExpanded = expandedId === record.id;
          const date = new Date(record.timestamp);
          const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
          const canReuse = workflows.some(w => w.id === record.workflowId) && record.status !== 'failed';

          // Status icon + border color
          const StatusIcon = record.status === 'success' ? CheckCircle2
            : record.status === 'failed' ? XCircle
            : MinusCircle;
          const statusIconColor = record.status === 'success' ? 'text-emerald-500'
            : record.status === 'failed' ? 'text-rose-500'
            : 'text-gray-400';
          const borderClass = record.status === 'success'
            ? 'bg-[var(--bg-stage)] border-[var(--border-subtle)] hover:border-emerald-500/30'
            : record.status === 'failed'
              ? 'bg-rose-500/5 border-rose-500/20 hover:border-rose-500/40'
              : 'bg-[var(--bg-stage)] border-[var(--border-subtle)] hover:border-gray-400/30';

          return (
            <div
              key={record.id}
              className={`rounded-lg border transition-all cursor-pointer group/record ${borderClass}`}
              onClick={() => setExpandedId(isExpanded ? null : record.id)}
            >
              {/* Compact row */}
              <div className="flex items-center gap-2 px-2.5 py-2">
                <StatusIcon size={11} className={`${statusIconColor} shrink-0`} />
                <div className="flex-1 min-w-0">
                  <p className="text-[9px] font-bold text-[var(--text-main)] truncate">
                    {record.workflowName}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {record.seed != null && (
                    <span className="text-[8px] text-[var(--text-muted)] font-mono">
                      s:{record.seed}
                    </span>
                  )}
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
                    <DetailRow label="Workflow" value={record.workflowName} />
                    <DetailRow label="Mode" value={record.mode} />
                    <DetailRow label="Env" value={record.envName} />
                    {record.seed != null && <DetailRow label="Seed" value={String(record.seed)} />}
                    {record.durationMs != null && <DetailRow label="Duration" value={`${record.durationMs}ms`} />}
                    {record.outputCount != null && <DetailRow label="Outputs" value={String(record.outputCount)} />}
                  </div>
                  {record.positivePrompt && (
                    <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                      <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
                        Prompt
                      </span>
                      <p className="text-[9px] text-[var(--text-main)] mt-0.5 leading-relaxed break-words">
                        {record.positivePrompt}
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
                  {/* Reuse Params button */}
                  {canReuse && (
                    <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                      <button
                        onClick={(e) => { e.stopPropagation(); onReuseParams(record); }}
                        className="flex items-center gap-1 text-[9px] font-bold text-emerald-500 hover:text-emerald-400 transition-colors uppercase tracking-wider focus:outline-none"
                      >
                        <RotateCcw size={10} /> Reuse Params
                      </button>
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
