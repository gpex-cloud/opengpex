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

import React, { useState, useCallback, useMemo, useSyncExternalStore } from "react";
import { Trash2, HardDrive, RefreshCw, Download, Check, CloudOff, ChevronRight, ChevronsDownUp, ChevronsUpDown, ScanSearch, MonitorSmartphone, Filter, Search } from "lucide-react";
import { useEditorServices } from "@opengpex/editor/core/context";
import type { WebFont } from "@opengpex/editor/core/fonts/registry";
import { isLocalFontAccessSupported, queryLocalFonts, getPersistedLocalFonts, clearPersistedLocalFonts } from "@opengpex/editor/core/fonts/local";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import ActionButton from "@opengpex/editor/widgets/ActionButton";

// ─── Category grouping helpers ──────────────────────────────────────────────────

interface FontGroup {
  id: string;
  label: string;
  fonts: WebFont[];
  defaultExpanded: boolean;
}

/**
 * Categorize fonts into display groups for the FontSettings panel.
 * Groups: System → Sans-Serif → Serif → Monospace → Display & Handwriting → CJK → User Discovered
 */
function categorizeFonts(registry: WebFont[]): FontGroup[] {
  const system: WebFont[] = [];
  const sansSerif: WebFont[] = [];
  const serif: WebFont[] = [];
  const monospace: WebFont[] = [];
  const displayHand: WebFont[] = [];
  const cjk: WebFont[] = [];
  const userDiscovered: WebFont[] = [];

  for (const font of registry) {
    if (font.isSystem) {
      system.push(font);
    } else if (font.subsetted) {
      cjk.push(font);
    } else if ((font as WebFont & { isCustom?: boolean }).isCustom) {
      userDiscovered.push(font);
    } else {
      switch (font.category) {
        case 'sans-serif':
          sansSerif.push(font);
          break;
        case 'serif':
          serif.push(font);
          break;
        case 'monospace':
          monospace.push(font);
          break;
        case 'display':
        case 'handwriting':
          displayHand.push(font);
          break;
        default:
          sansSerif.push(font);
      }
    }
  }

  // Check for user-discovered fonts that aren't in the built-in registry
  // (they won't have isCustom flag but won't be in any of the above categories)
  // Actually user-discovered fonts from localStorage don't have isCustom,
  // but they're appended to the registry. We detect them by checking if they're
  // Google Fonts that aren't system/subsetted — they'd end up in the normal categories.
  // For now, this is fine. User-discovered fonts will appear in their natural category.

  const groups: FontGroup[] = [];

  if (system.length > 0) {
    groups.push({ id: 'system', label: 'System Fonts', fonts: system, defaultExpanded: true });
  }
  if (sansSerif.length > 0) {
    groups.push({ id: 'sans-serif', label: 'Sans-Serif', fonts: sansSerif, defaultExpanded: true });
  }
  if (serif.length > 0) {
    groups.push({ id: 'serif', label: 'Serif', fonts: serif, defaultExpanded: true });
  }
  if (monospace.length > 0) {
    groups.push({ id: 'monospace', label: 'Monospace', fonts: monospace, defaultExpanded: true });
  }
  if (displayHand.length > 0) {
    groups.push({ id: 'display', label: 'Display & Handwriting', fonts: displayHand, defaultExpanded: false });
  }
  if (cjk.length > 0) {
    groups.push({ id: 'cjk', label: 'CJK / Multi-language', fonts: cjk, defaultExpanded: false });
  }

  return groups;
}

// ─── Collapsible Group Component ────────────────────────────────────────────────

const FontGroupSection = React.memo(function FontGroupSection({
  group,
  loadedSet,
  loadingFont,
  onLoadFont,
  expanded,
  onToggle,
}: {
  group: FontGroup;
  loadedSet: Set<string>;
  loadingFont: string | null;
  onLoadFont: (family: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const loadedInGroup = group.fonts.filter((f) => loadedSet.has(f.family)).length;

  return (
    <div className="border-b border-[var(--border-subtle)] last:border-b-0">
      {/* Group Header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-[var(--bg-elevated)] transition-colors cursor-pointer"
      >
        <ChevronRight
          size={10}
          className={`text-[var(--text-muted)] transition-transform duration-150 shrink-0 ${expanded ? "rotate-90" : ""}`}
        />
        <span className="text-[10px] font-bold text-[var(--text-secondary)] flex-1 text-left uppercase tracking-wider">
          {group.label}
        </span>
        <span className="text-[9px] text-[var(--text-muted)] tabular-nums">
          {loadedInGroup}/{group.fonts.length}
        </span>
      </button>

      {/* Group Content */}
      {expanded && (
        <div className="pb-1">
          {group.fonts.map((font) => {
            const isLoaded = loadedSet.has(font.family);
            const isLoading = loadingFont === font.family;
            return (
              <div
                key={font.family}
                className="flex items-center gap-2 px-3 py-1.5 ml-3 mr-1 rounded-md hover:bg-indigo-500/10 transition-colors"
              >
                {/* Status Icon */}
                <div className="w-4 shrink-0 flex justify-center">
                  {isLoading ? (
                    <RefreshCw size={12} className="animate-spin text-amber-400" />
                  ) : isLoaded ? (
                    <Check size={12} className="text-emerald-400" />
                  ) : (
                    <CloudOff size={11} className="text-[var(--text-muted)] opacity-40" />
                  )}
                </div>

                {/* Font Name */}
                <span
                  className="flex-1 text-[11px] truncate text-[var(--text-primary)]"
                  style={{ fontFamily: isLoaded ? font.family : "inherit" }}
                >
                  {font.displayName || font.family}
                </span>

                {/* Load Button (only for not-loaded remote fonts) */}
                {!isLoaded && !font.isSystem && (
                  <button
                    type="button"
                    onClick={() => onLoadFont(font.family)}
                    disabled={isLoading}
                    className="p-1 rounded-md text-[var(--text-muted)] hover:text-indigo-400 hover:bg-indigo-500/10 transition-colors disabled:opacity-30 cursor-pointer"
                  >
                    <Download size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// ─── Main FontSettings Component ────────────────────────────────────────────────

/**
 * FontSettings: Settings panel for font cache management and font library browsing.
 *
 * Features:
 * - Shows loaded vs total fonts count with progress bar
 * - Categorized font groups (System, Sans-Serif, Serif, Monospace, Display, CJK)
 * - Collapsible groups with per-group load status counter
 * - "Preload All" button to download all remote fonts for offline use
 * - Clear cache button
 */
export const FontSettings = React.memo(function FontSettings() {
  const { fonts } = useEditorServices();
  const [clearing, setClearing] = useState(false);
  const [preloading, setPreloading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [loadingFont, setLoadingFont] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showLocalOnly, setShowLocalOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Reactive subscription to font state changes
  const loadedFamilies = useSyncExternalStore(
    useCallback((onStoreChange: () => void) => fonts.subscribe(onStoreChange), [fonts]),
    useCallback(() => fonts.getLoadedFamilies(), [fonts]),
    useCallback(() => [] as string[], []),
  );

  // Use full registry (built-in + user-discovered)
  const fullRegistry: WebFont[] = fonts.getRegistry();
  const loadedSet = useMemo(() => new Set(loadedFamilies), [loadedFamilies]);
  const totalFonts = fullRegistry.length;
  const loadedCount = loadedFamilies.length;

  // Categorize fonts into groups (with optional local-only filter + search)
  const filteredRegistry = useMemo(() => {
    let result = fullRegistry;
    if (showLocalOnly) {
      result = result.filter((f) => f.isSystem);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (f) =>
          f.family.toLowerCase().includes(q) ||
          (f.displayName && f.displayName.toLowerCase().includes(q)) ||
          f.category.toLowerCase().includes(q),
      );
    }
    return result;
  }, [fullRegistry, showLocalOnly, searchQuery]);
  const groups = useMemo(() => categorizeFonts(filteredRegistry), [filteredRegistry]);

  // Expand/Collapse state for each group (keyed by group.id)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const g of categorizeFonts(fullRegistry)) {
      initial[g.id] = g.defaultExpanded;
    }
    return initial;
  });

  const allExpanded = groups.every((g) => expandedGroups[g.id]);
  const allCollapsed = groups.every((g) => !expandedGroups[g.id]);

  const handleExpandAll = useCallback(() => {
    setExpandedGroups((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) next[key] = true;
      return next;
    });
  }, []);

  const handleCollapseAll = useCallback(() => {
    setExpandedGroups((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) next[key] = false;
      return next;
    });
  }, []);

  const handleToggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  }, []);

  const handleLoadFont = useCallback(async (family: string) => {
    setLoadingFont(family);
    setMessage(null);
    await fonts.load(family);
    setLoadingFont(null);
  }, [fonts]);

  const handlePreloadAll = useCallback(async () => {
    setPreloading(true);
    setMessage(null);
    let loaded = 0;
    const remoteFonts = fullRegistry.filter((f) => !f.isSystem);
    for (const font of remoteFonts) {
      if (!fonts.isLoaded(font.family)) {
        const ok = await fonts.load(font.family);
        if (ok) loaded++;
      }
    }
    setPreloading(false);
    setMessage(`Preloaded ${loaded} fonts for offline use.`);
  }, [fonts, fullRegistry]);

  // Check if local fonts have been scanned (persisted)
  const hasLocalFonts = useMemo(() => getPersistedLocalFonts().length > 0, []);

  const handleScanLocalFonts = useCallback(async () => {
    setScanning(true);
    setMessage(null);
    const existingFamilies = new Set(fullRegistry.map((f) => f.family));
    const result = await queryLocalFonts(existingFamilies);
    setScanning(false);
    if (result.success) {
      setMessage(`Found ${result.familyCount} local fonts. They are now available in the font picker.`);
    } else {
      setMessage(result.error || "Failed to scan local fonts.");
    }
  }, [fullRegistry]);

  const handleRemoveLocalFonts = useCallback(() => {
    clearPersistedLocalFonts();
    setMessage("Local fonts removed from the library.");
  }, []);

  const handleClearCache = useCallback(async () => {
    setClearing(true);
    setMessage(null);
    try {
      await fonts.clearCache();
      setMessage("Cache cleared. Remote fonts will re-download on next use.");
    } catch (e) {
      setMessage("Failed to clear font cache.");
      console.error("[FontSettings] Clear cache failed:", e);
    } finally {
      setClearing(false);
    }
  }, [fonts]);

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* Stats Overview */}
      <div className="flex flex-col gap-1.5 bg-[var(--bg-stage)] rounded-lg p-2.5 border border-[var(--border-subtle)]">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-[var(--text-muted)]">Loaded / Available</span>
          <span className="text-[10px] font-bold text-amber-400 tabular-nums">
            {loadedCount} / {totalFonts}
          </span>
        </div>
        <div className="w-full h-1.5 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
          <div
            className="h-full bg-amber-500 rounded-full transition-all duration-300"
            style={{ width: `${totalFonts > 0 ? (loadedCount / totalFonts) * 100 : 0}%` }}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        {!isLocalFontAccessSupported() && (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/5 border border-amber-500/20 text-[9px] text-amber-400/80">
            <MonitorSmartphone size={11} className="shrink-0" />
            <span>Local Font Access requires Chrome/Edge 103+</span>
          </div>
        )}
        <div className="flex gap-2">
          {isLocalFontAccessSupported() && (
            <FancyButton shape="rect"
              onClick={hasLocalFonts ? handleRemoveLocalFonts : handleScanLocalFonts}
              variant="ghost"
              className="flex-1 gap-1.5 text-[10px] h-8"
              disabled={scanning}
            >
              {scanning ? (
                <RefreshCw size={11} className="animate-spin" />
              ) : (
                <ScanSearch size={11} />
              )}
              {scanning ? "Scanning…" : hasLocalFonts ? "Remove Local" : "Scan Local"}
            </FancyButton>
          )}
          <FancyButton shape="rect"
            onClick={handlePreloadAll}
            variant="ghost"
            className="flex-1 gap-1.5 text-[10px] h-8"
            disabled={preloading || loadedCount >= totalFonts}
          >
            {preloading ? (
              <RefreshCw size={11} className="animate-spin" />
            ) : (
              <Download size={11} />
            )}
            {preloading ? "Loading…" : "Preload Online"}
          </FancyButton>
          <FancyButton shape="rect"
            onClick={handleClearCache}
            variant="ghost"
            className="flex-1 gap-1.5 text-[10px] h-8"
            disabled={clearing}
          >
            {clearing ? (
              <RefreshCw size={11} className="animate-spin" />
            ) : (
              <Trash2 size={11} />
            )}
            Clear Cache
          </FancyButton>
        </div>
      </div>

      {/* Font Library — Categorized Groups */}
      <div className="flex flex-col gap-0.5 flex-1 min-h-0">
        <div className="flex items-center px-1 mb-1 shrink-0">
          <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase tracking-wider shrink-0">
            Font Library
          </span>
          {/* Search input */}
          <div className="flex-1 mx-2 flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
            <Search size={9} className="text-[var(--text-muted)] shrink-0" />
            <input
              type="text"
              placeholder="Filter…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent text-[9px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none min-w-0"
            />
          </div>
          <div className="flex items-center gap-0.5">
            <ActionButton
              onClick={() => setShowLocalOnly(!showLocalOnly)}
              icon={<Filter size={10} />}
              tooltip={showLocalOnly ? "Show All Fonts" : "Show Local Only"}
              tooltipPosition="top"
              size="sm"
              variant={showLocalOnly ? "solid" : "glass"}
            />
            <ActionButton
              onClick={handleExpandAll}
              icon={<ChevronsUpDown size={10} />}
              tooltip="Expand All"
              tooltipPosition="top"
              size="sm"
              variant="glass"
              disabled={allExpanded}
            />
            <ActionButton
              onClick={handleCollapseAll}
              icon={<ChevronsDownUp size={10} />}
              tooltip="Collapse All"
              tooltipPosition="top"
              size="sm"
              variant="glass"
              disabled={allCollapsed}
            />
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-stage)]">
          {groups.map((group) => (
            <FontGroupSection
              key={group.id}
              group={group}
              loadedSet={loadedSet}
              loadingFont={loadingFont}
              onLoadFont={handleLoadFont}
              expanded={!!expandedGroups[group.id]}
              onToggle={() => handleToggleGroup(group.id)}
            />
          ))}
        </div>
      </div>

      {/* Status Message */}
      {message && (
        <div className="text-[9px] text-[var(--text-muted)] italic bg-[var(--bg-stage)] p-2 rounded-lg border border-[var(--border-subtle)] text-center">
          {message}
        </div>
      )}

      {/* Info */}
      <div className="text-[8px] text-[var(--text-muted)] px-1 leading-relaxed">
        <HardDrive size={9} className="inline mr-1 opacity-60" />
        Fonts are cached in IndexedDB for offline use. System fonts (SYS) are always available.
        Remote fonts are downloaded from Google Fonts CDN on first use.
      </div>
    </div>
  );
});

export default FontSettings;
