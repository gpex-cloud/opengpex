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
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

"use client";

import React, { useState } from "react";
import { ScanSearch, Loader2, AlertTriangle, Landmark } from "lucide-react";
import type { SegmentDefinition } from "../protocols";
import { SEGMENT_COLORS } from "../protocols";
import type { ZAuditEntry, ZAuditResult } from "../hooks";

interface RuntimeZAuditProps {
  segmentStack: SegmentDefinition[];
  result: ZAuditResult | null;
  scanning: boolean;
  onScan: () => void;
}

/**
 * Live child counts of the portal segment roots: which island currently
 * hosts content. Read on render — the panel re-renders on every scan and on
 * every slot interaction, which is enough for a debugging readout.
 */
function readPortalRootCounts(segmentStack: SegmentDefinition[]) {
  return segmentStack
    .filter(s => s.portalRootId)
    .map(s => ({
      segment: s,
      count: typeof document !== "undefined"
        ? document.getElementById(s.portalRootId!)?.childElementCount ?? null
        : null,
    }));
}

function EntryRow({ entry, tone }: { entry: ZAuditEntry; tone: "ok" | "warn" | "bad" }) {
  const [open, setOpen] = useState(false);
  const toneClass =
    tone === "bad"
      ? "border-rose-500/40 bg-rose-500/[0.06]"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/[0.04]"
        : "border-[var(--border-subtle)] bg-[var(--bg-stage)]";
  return (
    <button
      onClick={() => setOpen(v => !v)}
      className={`w-full text-left p-2 rounded-xl border transition-all outline-none cursor-pointer ${toneClass} hover:border-[var(--border-light)]`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-black text-[10px] tabular-nums text-[var(--text-main)]">z {entry.z}</span>
        <span
          className={`flex-1 min-w-0 truncate text-[8px] font-black uppercase ${
            entry.seatLabel ? "text-emerald-600" : tone === "bad" ? "text-rose-500" : "text-amber-600"
          }`}
        >
          {entry.seatLabel ?? (tone === "bad" ? "out of segment" : "unmapped (local / relative)")}
        </span>
        <span className="text-[8px] font-black text-[var(--text-muted)] tabular-nums">×{entry.count}</span>
      </div>
      {open && entry.samples.length > 0 && (
        <div className="mt-1.5 space-y-0.5 pl-1">
          {entry.samples.map((sample, i) => (
            <div key={`${i}-${sample}`} className="text-[7.5px] font-mono text-[var(--text-muted)] truncate">
              {sample}
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

/**
 * RuntimeZAudit: one-shot DOM scan view. Lists every effective z-index
 * grouped by matrix segment, with out-of-segment values pinned in a red zone
 * at the top — the runtime twin of the zIndexSegmentGuard source test.
 */
export function RuntimeZAudit({ segmentStack, result, scanning, onScan }: RuntimeZAuditProps) {
  const portalCounts = readPortalRootCounts(segmentStack);

  return (
    <div className="w-full h-full flex flex-col gap-2 min-h-0 font-mono text-[9px]">
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-shrink-0">
        <button
          onClick={onScan}
          disabled={scanning}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-500 text-white text-[8px] font-black uppercase tracking-wide outline-none cursor-pointer disabled:opacity-60 hover:bg-indigo-600 transition-colors"
        >
          {scanning ? <Loader2 size={10} className="animate-spin" /> : <ScanSearch size={10} />}
          {scanning ? "Scanning…" : result ? "Rescan DOM" : "Scan DOM"}
        </button>
        {result && (
          <span className="text-[7.5px] font-black text-[var(--text-muted)] tabular-nums uppercase">
            {result.elementTotal} elements · {new Date(result.scannedAt).toLocaleTimeString()}
            {result.truncated && <span className="text-amber-600"> · truncated</span>}
          </span>
        )}
      </div>

      {/* Portal root activity */}
      <div className="flex items-center gap-1 flex-wrap flex-shrink-0">
        {portalCounts.map(({ segment, count }) => {
          const colors = SEGMENT_COLORS[segment.color] ?? SEGMENT_COLORS.emerald;
          return (
            <span
              key={segment.id}
              title={`#${segment.portalRootId}`}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[7px] font-black uppercase ${colors.chip}`}
            >
              <Landmark size={7} />
              {segment.level} {segment.name}: {count === null ? "—" : `${count} child${count === 1 ? "" : "ren"}`}
            </span>
          );
        })}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1 scrollbar-hide">
        {!result && !scanning && (
          <div className="flex flex-col items-center justify-center py-10 rounded-2xl border border-dashed border-[var(--border-subtle)] text-[var(--text-muted)] text-center gap-1.5">
            <ScanSearch size={16} className="opacity-40" />
            <span className="text-[9px] font-black uppercase tracking-wider">No scan yet</span>
            <span className="text-[7.5px] font-bold normal-case leading-relaxed max-w-[240px]">
              Scan reads every element&apos;s computed z-index and files it into the segment matrix.
              Open the UI state you want to inspect first (a dialog, a menu, a tool), then scan.
            </span>
          </div>
        )}

        {result && result.outOfSegment.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-[8px] font-black uppercase tracking-wider text-rose-500">
              <AlertTriangle size={9} />
              Out of segment ({result.outOfSegment.length})
            </div>
            {result.outOfSegment.map(entry => (
              <EntryRow key={entry.z} entry={entry} tone="bad" />
            ))}
          </div>
        )}

        {result &&
          segmentStack.map(segment => {
            const entries = result.entries.filter(e => e.segmentId === segment.id);
            if (entries.length === 0) return null;
            const colors = SEGMENT_COLORS[segment.color] ?? SEGMENT_COLORS.emerald;
            return (
              <div key={segment.id} className="space-y-1">
                <div className={`flex items-center gap-1 text-[8px] font-black uppercase tracking-wider ${colors.text}`}>
                  <span>{segment.level}</span>
                  <span>{segment.name}</span>
                  <span className="opacity-60 tabular-nums">
                    {segment.base}–{segment.base + 999}
                  </span>
                </div>
                {entries.map(entry => (
                  <EntryRow key={entry.z} entry={entry} tone={entry.seatLabel ? "ok" : "warn"} />
                ))}
              </div>
            );
          })}
      </div>
    </div>
  );
}
