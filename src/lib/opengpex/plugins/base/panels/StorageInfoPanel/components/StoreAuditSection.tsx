/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

"use client";

import React, { useEffect, useState } from "react";
import { useEditorServices } from "@opengpex/editor/core/context";
import { Database, ChevronRight, ChevronDown, HardDrive } from "lucide-react";
import * as Prot from "../protocols";
import { formatBytes } from "./shared";

/** Shared ISO-day bucketing so the tree filter can target the same day keys. */
export const dayOf = (ts?: number): string =>
  ts ? new Date(ts).toISOString().slice(0, 10) : "unknown";

interface StoreAuditHUDProps {
  storeAudit: Prot.StoreAuditSummary | null;
}

/**
 * STORE-level audit block for HUD (compact) mode: IndexedDB truth including
 * the raw:/dec: keyspaces the session pool never sees. The orphan line is the
 * headline — dead weight that the pool-only view was blind to.
 */
export function StoreAuditHUD({ storeAudit }: StoreAuditHUDProps) {
  if (!storeAudit) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 pl-1 text-emerald-600 opacity-90">
        <HardDrive size={10} />
        <span className="text-[9px] font-black uppercase tracking-widest">
          Store (IndexedDB) — {storeAudit.displayCount} assets · {storeAudit.rawCount} raw · {storeAudit.decCount} dec
        </span>
      </div>
      <div className="rounded-xl border border-[var(--border-subtle)] dark:border-white/[0.08] p-2 text-[9px] space-y-1">
        <div className="flex justify-between items-center">
          <span className="text-[var(--text-muted)]">TOTAL STORED</span>
          <span className="font-mono font-bold text-[var(--text-main)]">
            {formatBytes(storeAudit.totalBytes)}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-[var(--text-muted)]">Referenced (alive)</span>
          <span className="font-mono text-emerald-600">
            {formatBytes(storeAudit.aliveBytes)}
          </span>
        </div>
        {storeAudit.orphanCount > 0 && (
          <div className="flex justify-between items-center pt-1 border-t border-[var(--border-subtle)] dark:border-t-white/[0.06]">
            <span className="text-rose-500 font-bold uppercase tracking-wider">
              Orphans ({storeAudit.orphanCount})
            </span>
            <span className="font-mono font-bold text-rose-500">
              {formatBytes(storeAudit.orphanBytes)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

interface StoreAuditTreeNodeProps {
  storeAudit: Prot.StoreAuditSummary | null;
  expandedNodes: Record<string, boolean>;
  selectedNodeId: string | null;
  toggleNode: (key: string) => void;
  setSelectedNode: (
    node: { type: "frame" | "layer" | "asset" | "history" | "store"; id: string; data: unknown } | null,
  ) => void;
}

/**
 * STORE-level tree node for expanded dashboard mode. Orphans are grouped by
 * creation day (the triage view that answered "when did this dead weight
 * appear?" during the 2026-11-14 wipe post-mortem); alive entries collapse
 * into a single summary line.
 */
export function StoreAuditTreeNode({
  storeAudit,
  expandedNodes,
  selectedNodeId,
  toggleNode,
  setSelectedNode,
}: StoreAuditTreeNodeProps) {
  if (!storeAudit) return null;

  // raw:/dec: payloads carry no timestamp/name of their own — join them to the
  // display record they belong to (dec: keys off the full unified id
  // hash#index, raw: off the file-hash prefix) for both the day grouping and
  // the source-file label.
  const heavyOwner = (entry: Prot.StoreAuditEntryView): Prot.StoreAuditEntryView | undefined => {
    const bare = entry.key.slice(4);
    return storeAudit.entries.find(
      (e) => e.kind === 'display' && (e.key === bare || e.key.split('#')[0] === bare),
    );
  };

  const orphanDays = new Map<string, Prot.StoreAuditEntryView[]>();
  for (const entry of storeAudit.orphans) {
    // raw:/dec: inherit the owning display record's creation date.
    const day = dayOf(entry.timestamp ?? heavyOwner(entry)?.timestamp);
    if (!orphanDays.has(day)) orphanDays.set(day, []);
    orphanDays.get(day)!.push(entry);
  }
  const days = [...orphanDays.entries()].sort(([a], [b]) => b.localeCompare(a));

  const selectEntry = (entry: Prot.StoreAuditEntryView) => {
    setSelectedNode({ type: "store", id: entry.key, data: entry });
  };



  return (
    <div className="flex flex-col">
      <div
        onClick={() => toggleNode("store")}
        className="flex items-center gap-2 py-1 px-2 rounded-lg hover cursor-pointer text-[var(--text-main)] font-bold transition-colors whitespace-nowrap"
      >
        {expandedNodes.store ? (
          <ChevronDown size={11} className="text-[var(--text-muted)]" />
        ) : (
          <ChevronRight size={11} className="text-[var(--text-muted)]" />
        )}
        <HardDrive size={11} className="text-emerald-600" />
        <span className="whitespace-nowrap">
          store-indexeddb ({storeAudit.displayCount} assets · {storeAudit.rawCount} raw · {storeAudit.decCount} dec
          {storeAudit.orphanCount > 0 ? ` · ${storeAudit.orphanCount} orphan${storeAudit.orphanCount > 1 ? 's' : ''}` : ''})
        </span>
      </div>

      {expandedNodes.store && (
        <div className="pl-2 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-2.5 space-y-1 mt-0.5">
          {/* Referenced (alive) entries — full明细, selectable like orphans */}
          <div
            onClick={() => toggleNode("store-alive")}
            className="flex items-center gap-2 py-0.5 px-2 rounded hover cursor-pointer text-[var(--text-muted)]"
          >
            {expandedNodes["store-alive"] ? (
              <ChevronDown size={10} className="opacity-70" />
            ) : (
              <ChevronRight size={10} className="opacity-70" />
            )}
            <span className="font-mono text-[9px]">in-use</span>
            <span className="ml-auto font-mono text-[8px] text-emerald-600">
              {storeAudit.entries.length - storeAudit.orphanCount} · {formatBytes(storeAudit.aliveBytes)}
            </span>
          </div>
          {expandedNodes["store-alive"] &&
            storeAudit.entries
              .filter((e) => e.alive)
              .map((entry) => (
                <div
                  key={entry.key}
                  onClick={() => setSelectedNode({ type: "store", id: entry.key, data: entry })}
                  className={`flex justify-between items-center py-0.5 px-2 ml-2.5 rounded hover cursor-pointer ${
                    selectedNodeId === entry.key
                      ? "bg-emerald-500/10 text-emerald-600 font-bold"
                      : "text-[var(--text-muted)]"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="px-1 py-0.5 rounded text-[7px] font-black uppercase font-mono bg-emerald-500/10 text-emerald-600">
                      {entry.kind}
                    </span>
                    <span className="truncate font-mono text-[9px]">
                      {entry.kind === "display" && entry.sourceFileName
                        ? entry.sourceFileName
                        : entry.key.slice(0, 16)}
                      {entry.kind === "display" && entry.width ? ` ${entry.width}×${entry.height}` : ""}
                    </span>
                  </div>
                  <span className="font-mono text-[8px]">
                    {entry.size >= 0 ? formatBytes(entry.size) : "?"}
                  </span>
                </div>
              ))}

          {/* Orphans grouped by creation day, newest first */}
          {days.map(([day, entries]) => (
            <div key={day} className="flex flex-col">
              <div
                onClick={() => toggleNode(`store-day-${day}`)}
                className="flex items-center gap-2 py-0.5 px-2 rounded hover cursor-pointer text-rose-500"
              >
                {expandedNodes[`store-day-${day}`] ? (
                  <ChevronDown size={10} className="opacity-70" />
                ) : (
                  <ChevronRight size={10} className="opacity-70" />
                )}
                <span className="font-mono text-[9px]">{day}</span>
                <span className="font-mono text-[8px] opacity-70">
                  {entries.length} · {formatBytes(entries.reduce((s, e) => s + Math.max(0, e.size), 0))}
                </span>
              </div>
              {expandedNodes[`store-day-${day}`] &&
                entries.map((entry) => (
                  <div
                    key={entry.key}
                    onClick={() => selectEntry(entry)}
                    className={`flex justify-between items-center py-0.5 px-2 ml-3 rounded hover cursor-pointer ${
                      selectedNodeId === entry.key
                        ? "bg-rose-500/10 text-rose-500 font-bold"
                        : "text-[var(--text-muted)]"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`px-1 py-0.5 rounded text-[7px] font-black uppercase font-mono ${
                          entry.kind === "display"
                            ? "bg-indigo-500/10 text-indigo-500"
                            : entry.kind === "raw"
                              ? "bg-amber-500/10 text-amber-600"
                              : "bg-cyan-500/10 text-cyan-600"
                        }`}
                      >
                        {entry.kind}
                      </span>
                      <span className="truncate font-mono text-[9px]">
                        {entry.kind === "display" && entry.sourceFileName
                          ? entry.sourceFileName
                          : entry.key.slice(0, 16)}
                        {entry.kind === "display" && entry.width
                          ? ` ${entry.width}×${entry.height}`
                          : ""}
                      </span>
                    </div>
                    <span className="font-mono text-[8px]">
                      {entry.size >= 0 ? formatBytes(entry.size) : "?"}
                    </span>
                  </div>
                ))}
          </div>
        ))}
        </div>
      )}
    </div>
  );
}

/**
 * On-demand preview for a store entry: the ObjectURL is fetched fresh from
 * IndexedDB when the selection changes and revoked on unmount/switch.
 * `dec:` entries are naked float pixels (no container) — no preview.
 */
function StoreAuditPreview({ entryKey, kind }: { entryKey: string; kind: string }) {
  const { assets } = useEditorServices();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    let created: string | null = null;
    void assets.getAssetPreviewUrl(entryKey).then((u) => {
      if (!live) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      if (u) {
        created = u;
        setUrl(u);
      } else {
        setFailed(true);
      }
    });
    return () => {
      live = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [entryKey, assets]);

  if (kind === 'dec') {
    return (
      <div className="p-2 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] text-[8px] font-mono text-[var(--text-muted)]">
        Preview unavailable — naked float pixels (no container).
      </div>
    );
  }
  if (failed) {
    return (
      <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[8px] font-mono text-amber-600">
        Preview failed to decode this blob.
      </div>
    );
  }
  if (!url) return null;
  return (
    <div className="w-full h-24 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] overflow-hidden flex items-center justify-center">
      <img src={url} alt="" className="max-w-full max-h-full object-contain" />
    </div>
  );
}

interface StoreAuditDetailsProps {
  entry: Prot.StoreAuditEntryView;
}

/**
 * Details-inspector block for a selected store entry.
 */
export function StoreAuditDetails({ entry }: StoreAuditDetailsProps) {
  const rows: Array<[string, string]> = [
    ["KEY", entry.key],
    ["KIND", entry.kind.toUpperCase()],
    ["SIZE", entry.size >= 0 ? formatBytes(entry.size) : "unknown"],
    ["STATUS", entry.alive ? "ALIVE" : "ORPHAN"],
  ];
  if (entry.kind === "display") {
    rows.push(["DIMENSIONS", entry.width ? `${entry.width}×${entry.height} px` : "—"]);
    if (entry.sourceFileName) rows.push(["SOURCE FILE", entry.sourceFileName]);
    if (entry.dataFormat) rows.push(["HIGH-DEPTH", entry.dataFormat.toUpperCase()]);
  }
  if (entry.timestamp) {
    rows.push(["CREATED", new Date(entry.timestamp).toLocaleString()]);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Database size={10} className="text-emerald-600" />
        <span className="text-[8px] font-black uppercase text-[var(--text-muted)]">
          Store Entry (IndexedDB)
        </span>
      </div>
      <StoreAuditPreview key={entry.key} entryKey={entry.key} kind={entry.kind} />
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex justify-between py-1 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06]"
        >
          <span className="text-[var(--text-muted)]">{label}</span>
          <span
            className={`truncate max-w-[160px] font-mono ${
              label === "STATUS" && !entry.alive ? "text-rose-500 font-bold" : "text-[var(--text-main)]"
            }`}
            title={value}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}
