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

import React, { useMemo, useState } from "react";
import {
  Search,
  Stethoscope,
  Copy,
  Check,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { useEditorState, usePluginList } from "@opengpex/editor/core/context";
import type { Frame, Layer } from "@opengpex/editor/core/types";

/**
 * Read-only runtime diagnostics view for GPEX-Hub.
 *
 * Renders the full persisted pluginConfig tree plus a runtime snapshot of the
 * active frame, purely for human inspection during state-corruption
 * investigations. Hard constraint: NOTHING in this view may write, clear or
 * mutate any state — the only permitted interaction is copying JSON text to
 * the clipboard.
 */

/** Max character length for a single string when rendered for display. */
const DISPLAY_STRING_LIMIT = 120;

/** JSON.stringify that never throws on cycles (corrupt state tolerance). */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, val: unknown) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      },
      2,
    );
  } catch {
    return String(value);
  }
}

/**
 * Display-safe deep clone: truncates long strings (pathData, base64 blobs)
 * so huge configs render quickly. The full untruncated value is used only by
 * the copy button.
 */
function truncateForDisplay(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > DISPLAY_STRING_LIMIT
      ? `${value.slice(0, DISPLAY_STRING_LIMIT)}… (${value.length} chars)`
      : value;
  }
  if (Array.isArray(value)) {
    if (depth > 12) return "[depth limit]";
    return value.map((item) => truncateForDisplay(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (depth > 12) return "[depth limit]";
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = truncateForDisplay(val, depth + 1);
    }
    return out;
  }
  return value;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      onClick={copy}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold cursor-pointer outline-none select-none transition-all duration-150 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-500/10 dark:hover:text-indigo-400 border border-zinc-200 dark:border-zinc-700/50 shrink-0"
      title="Copy full JSON to clipboard"
    >
      {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
      {copied ? "Copied" : (label ?? "Copy JSON")}
    </button>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg border border-zinc-200/60 dark:border-zinc-800 p-3 max-h-72 overflow-y-auto select-all">
      {safeStringify(truncateForDisplay(value))}
    </pre>
  );
}

function PluginConfigBlock({
  pluginKey,
  config,
  defaultOpen = false,
}: {
  pluginKey: string;
  config: Record<string, unknown>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const fullJson = useMemo(() => safeStringify(config), [config]);
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/30 dark:bg-zinc-900/30 overflow-hidden">
      <div
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center justify-between px-3 py-2 cursor-pointer outline-none hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? (
            <ChevronDown size={13} className="text-zinc-400 shrink-0" />
          ) : (
            <ChevronRight size={13} className="text-zinc-400 shrink-0" />
          )}
          <span className="text-xs font-bold text-zinc-800 dark:text-zinc-100 truncate font-mono">
            {pluginKey}
          </span>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <CopyButton text={fullJson} />
        </div>
      </div>
      {open && (
        <div className="px-3 pb-3">
          <JsonBlock value={config} />
        </div>
      )}
    </div>
  );
}

function RuntimeSnapshot({
  activeFrameId,
  interactionMode,
  frame,
  activeLayer,
}: {
  activeFrameId: string | null;
  interactionMode: string;
  frame: Frame | null;
  activeLayer: Layer | null;
}) {
  const rows: Array<{ label: string; value: React.ReactNode }> = [
    { label: "activeFrameId", value: activeFrameId ?? "(none)" },
    { label: "interactionMode", value: interactionMode },
    { label: "latestClipTool", value: frame?.latestClipTool ?? "(none)" },
    {
      label: "frame.confinement",
      value: frame?.confinement
        ? `present · feather=${frame.confinement.feather ?? 0} · rings=${frame.confinement.rings.length}`
        : "none",
    },
    {
      label: "activeLayer",
      value: activeLayer
        ? `${activeLayer.name || activeLayer.id} · type=${activeLayer.type} · nature=${activeLayer.nature}`
        : "(none)",
    },
  ];
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/30 dark:bg-zinc-900/30 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200/60 dark:border-zinc-800">
        <Stethoscope size={13} className="text-indigo-500 shrink-0" />
        <span className="text-xs font-black text-zinc-800 dark:text-zinc-100 tracking-tight">
          Runtime Snapshot
        </span>
      </div>
      <div className="grid grid-cols-1 gap-1.5 p-3 text-[10px] font-mono">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex justify-between gap-3 px-2 py-1 rounded bg-white/60 dark:bg-zinc-900/60 border border-zinc-200/50 dark:border-zinc-800"
          >
            <span className="text-zinc-400 shrink-0">{row.label}</span>
            <span className="font-bold text-zinc-700 dark:text-zinc-200 break-all text-right">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DiagnosticsTab() {
  const { state, activeFrame, activeLayer } = useEditorState();
  const pluginList = usePluginList();
  const [filter, setFilter] = useState("");

  const pluginConfig = state.pluginConfig;
  // pluginConfig only holds plugins whose config was overridden away from
  // initialConfig (persisted defaults are not seeded), so "persisted" is a
  // subset of "installed" — both counts are diagnostic facts.
  const entries = useMemo(
    () => Object.entries(pluginConfig).sort(([a], [b]) => a.localeCompare(b)),
    [pluginConfig],
  );
  const filtered = entries.filter(([key]) =>
    key.toLowerCase().includes(filter.toLowerCase()),
  );
  const persistedUids = useMemo(
    () => new Set(entries.map(([key]) => key)),
    [entries],
  );
  const installedWithoutConfig = useMemo(
    () =>
      pluginList
        .filter((p) => !persistedUids.has(p.uid))
        .map((p) => p.uid)
        .sort((a, b) => a.localeCompare(b)),
    [pluginList, persistedUids],
  );
  const filteredMissing = installedWithoutConfig.filter((uid) =>
    uid.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="absolute inset-0 overflow-y-auto p-4 space-y-3">
      {/* Search input: read-only view, filter does not mutate anything */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40">
        <Search size={13} className="text-zinc-400 shrink-0" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter plugins by key…"
          className="flex-1 bg-transparent outline-none text-xs text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-400"
        />
        <span className="text-[10px] font-bold text-zinc-400 shrink-0">
          {filtered.length} / {entries.length} persisted · {pluginList.length}{" "}
          installed
        </span>
      </div>

      <RuntimeSnapshot
        activeFrameId={state.activeFrameId}
        interactionMode={state.interaction.interactionMode}
        frame={activeFrame}
        activeLayer={activeLayer}
      />

      <div className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 tracking-wider uppercase pt-1">
        Persisted Plugin Config (read-only)
      </div>

      {filtered.length === 0 && filteredMissing.length === 0 ? (
        <div className="text-xs text-zinc-400 dark:text-zinc-500 py-8 text-center border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl">
          No plugin config matches this filter
        </div>
      ) : (
        <>
          {filtered.map(([key, config]) => (
            <PluginConfigBlock key={key} pluginKey={key} config={config} />
          ))}
          {filteredMissing.length > 0 && (
            <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 px-3 py-2">
              <div className="text-[9px] font-black text-zinc-400 dark:text-zinc-500 tracking-wider uppercase mb-1">
                Installed without persisted config ({filteredMissing.length})
              </div>
              <div className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500 leading-relaxed break-all">
                {filteredMissing.join(" · ")}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
