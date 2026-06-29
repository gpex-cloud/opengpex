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

import React, {
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
  useSyncExternalStore,
} from "react";
import { ChevronDown, Loader2, Search, Check, Download, Globe } from "lucide-react";
import { useEditorServices } from "@opengpex/editor/core/context";
import {
  getRecommendedFonts,
  splitFontsByLocale,
} from "@opengpex/editor/core/fonts/locale";
import type { WebFont } from "@opengpex/editor/core/fonts/registry";
import {
  searchGoogleFonts,
  saveUserDiscoveredFont,
} from "@opengpex/editor/core/fonts/discovery";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface FontPickerProps {
  /** Current font family value (CSS font-family string) */
  value: string;
  /** Callback when user selects a font */
  onChange: (family: string) => void;
  /** Optional label (default: "Font") */
  label?: string;
  /** Compact mode for inline usage */
  compact?: boolean;
  /** Optional font-weight applied to the display value (for live preview) */
  fontWeight?: number;
}

function cleanFamily(family: string): string {
  return family.split(",")[0].replace(/['"]/g, "").trim().toLowerCase();
}

function getFontDisplayName(family: string, registry: WebFont[]): string {
  const entry = registry.find(
    (f) => cleanFamily(f.family) === cleanFamily(family),
  );
  return (
    entry?.displayName ||
    entry?.family ||
    family.replace(/['",]/g, "").split(",")[0].trim()
  );
}

// ─── FontPicker Component ───────────────────────────────────────────────────────

/**
 * FontPicker: Dynamic font selection dropdown with search, locale grouping,
 * lazy loading indicators, live preview, and Google Fonts remote discovery.
 *
 * Features:
 * - Groups fonts by locale (recommended first, then by category)
 * - Shows loading spinner while font is being loaded
 * - Renders font names in their own typeface (live preview)
 * - Search/filter support with remote Google Fonts fallback
 * - Download status indicator (cloud icon for unloaded fonts)
 * - Keyboard navigation (Escape to close)
 */
export const FontPicker = React.memo(function FontPicker({
  value,
  onChange,
  label = "Font",
  compact = false,
  fontWeight,
}: FontPickerProps) {
  const { fonts } = useEditorServices();

  // Reactive subscription to font state changes
  useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => fonts.subscribe(onStoreChange),
      [fonts],
    ),
    useCallback(() => fonts.getLoadedFamilies(), [fonts]),
    useCallback(() => [] as string[], []),
  );

  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loadingFont, setLoadingFont] = useState<string | null>(null);
  const [remoteResults, setRemoteResults] = useState<WebFont[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Get full registry (built-in + user-discovered)
  const fullRegistry = useMemo(() => fonts.getRegistry(), [fonts]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setSearch("");
        setRemoteResults([]);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  // Compute grouped font list (locale-aware) using full registry
  const { recommended, primary, secondary } = useMemo(() => {
    const rec = getRecommendedFonts(fullRegistry);
    const split = splitFontsByLocale(fullRegistry);
    return {
      recommended: rec.slice(0, 6), // Top 6 for "Recommended" section
      primary: split.primary,
      secondary: split.secondary,
    };
  }, [fullRegistry]);

  // Filter by search (local) + trigger remote search
  const filteredFonts = useMemo(() => {
    if (!search.trim()) return null; // null = show grouped view
    const q = search.toLowerCase();
    return fullRegistry.filter(
      (f) =>
        f.family.toLowerCase().includes(q) ||
        f.category.toLowerCase().includes(q) ||
        (f.displayName && f.displayName.toLowerCase().includes(q)),
    );
  }, [search, fullRegistry]);

  // Remote search with debounce
  useEffect(() => {
    if (!search.trim() || (filteredFonts && filteredFonts.length >= 5)) {
      setRemoteResults([]);
      setIsSearching(false);
      return;
    }

    // Only trigger remote search if local results are few
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }

    searchDebounceRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const existingFamilies = new Set(fullRegistry.map((f) => f.family));
        const results = await searchGoogleFonts(search, existingFamilies, 10);
        setRemoteResults(results);
      } catch {
        setRemoteResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 400);

    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, [search, filteredFonts, fullRegistry]);

  // Handle font selection (local registry font)
  const handleSelect = useCallback(
    async (font: WebFont) => {
      const family = font.family;
      setLoadingFont(font.family);
      setIsOpen(false);
      setSearch("");
      setRemoteResults([]);

      // Trigger font loading
      if (!fonts.isLoaded(font.family)) {
        await fonts.load(font.family);
      }

      setLoadingFont(null);
      onChange(family);
    },
    [fonts, onChange],
  );

  // Handle font selection (discovered/remote font)
  const handleSelectDiscovered = useCallback(
    async (font: WebFont) => {
      const family = font.family;
      setLoadingFont(font.family);
      setIsOpen(false);
      setSearch("");
      setRemoteResults([]);

      // Persist to localStorage so it appears next time
      saveUserDiscoveredFont(font);

      // Load the font
      await fonts.loadDiscovered(font);

      setLoadingFont(null);
      onChange(family);
    },
    [fonts, onChange],
  );

  // Render a single font option
  const renderFontItem = (font: WebFont, isSelected: boolean, isRemote = false) => {
    const isLoaded = fonts.isLoaded(font.family);
    return (
      <button
        key={font.family}
        type="button"
        className={`
          w-full flex items-center gap-2 px-3 py-1.5 text-left text-[10px] font-bold transition-colors cursor-pointer rounded-md
          ${
            isSelected
              ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/20"
              : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-zinc-100"
          }
        `}
        onClick={() => isRemote ? handleSelectDiscovered(font) : handleSelect(font)}
        style={{
          fontFamily: isLoaded ? font.family : "inherit",
        }}
      >
        {/* Download status indicator */}
        <div className="w-3 shrink-0 flex items-center justify-center">
          {loadingFont === font.family ? (
            <Loader2 size={10} className="animate-spin text-amber-400" />
          ) : isSelected ? (
            <Check size={10} className="text-indigo-500" />
          ) : isLoaded ? (
            <Check size={8} className="text-emerald-400 opacity-60" />
          ) : isRemote ? (
            <Globe size={9} className="text-blue-400 opacity-70" />
          ) : (
            <Download size={9} className="text-zinc-400 dark:text-zinc-600 opacity-50" />
          )}
        </div>

        {/* Font Name */}
        <span className="flex-1 truncate">{font.displayName || font.family}</span>

        {/* Category/Type Tag */}
        <span
          className={`text-[8px] uppercase shrink-0 ${isSelected ? "text-indigo-500 dark:text-indigo-500" : "text-zinc-400 dark:text-zinc-500"}`}
        >
          {isRemote ? "WEB" : font.subsetted ? "CJK" : font.isSystem ? "SYS" : font.category?.slice(0, 4)}
        </span>
      </button>
    );
  };

  const currentDisplayName = getFontDisplayName(value, fullRegistry);

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`
          w-full flex items-center bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg transition-all hover:bg-zinc-50 dark:hover:bg-zinc-900/50 cursor-pointer
          ${compact ? "px-2 py-1 gap-1" : "px-2.5 py-1.5 gap-1.5"}
        `}
      >
        {label && !compact && (
          <span className="text-[9px] font-black text-zinc-400 dark:text-zinc-600 shrink-0 select-none uppercase tracking-tighter">
            {label}
          </span>
        )}
        <span
          className={`flex-1 truncate ${label && !compact ? "text-right" : "text-center pl-1"} text-[12px] text-zinc-900 dark:text-zinc-200`}
          style={{
            fontFamily: fonts.isLoaded(value) ? value : "inherit",
            fontWeight: fontWeight ?? 700,
          }}
        >
          {currentDisplayName}
        </span>
        {loadingFont && (
          <Loader2
            size={10}
            className="animate-spin text-zinc-400 dark:text-zinc-600 shrink-0"
          />
        )}
        <div className="pl-1.5 border-l border-zinc-200 dark:border-zinc-800 text-zinc-400 dark:text-zinc-600 hover:text-indigo-500 transition-colors">
          <ChevronDown
            size={12}
            className={`transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div
          className="absolute z-[999] top-full left-0 mt-1 w-72 max-h-80 overflow-hidden
            rounded-xl border border-[var(--border-subtle)]
            bg-[var(--bg-panel)] backdrop-blur-xl
            shadow-2xl shadow-black/50 flex flex-col animate-in fade-in slide-in-from-top-1 duration-150"
        >
          {/* Search */}
          <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-[var(--border-subtle)]">
            <Search size={12} className="text-[var(--text-muted)] shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search fonts… (also searches online fonts)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setIsOpen(false);
                  setSearch("");
                  setRemoteResults([]);
                }
              }}
              className="flex-1 bg-transparent text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
            {isSearching && (
              <Loader2 size={10} className="animate-spin text-[var(--text-muted)] shrink-0" />
            )}
          </div>

          {/* Font List */}
          <div className="overflow-y-auto flex-1 p-1.5 space-y-0.5">
            {filteredFonts ? (
              // Search mode
              <>
                {/* Local results */}
                {filteredFonts.length > 0 ? (
                  filteredFonts.map((f: WebFont) =>
                    renderFontItem(
                      f,
                      cleanFamily(f.family) === cleanFamily(value),
                    ),
                  )
                ) : !isSearching && remoteResults.length === 0 ? (
                  <div className="text-[10px] text-[var(--text-muted)] text-center py-4">
                    No fonts found
                  </div>
                ) : null}

                {/* Remote results from Google Fonts */}
                {remoteResults.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 px-1.5 py-1.5 mt-1">
                      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
                      <span className="text-[8px] font-bold text-blue-400 uppercase tracking-wider shrink-0 flex items-center gap-1">
                        <Globe size={8} />
                        Google Fonts
                      </span>
                      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
                    </div>
                    {remoteResults.map((f: WebFont) =>
                      renderFontItem(
                        f,
                        cleanFamily(f.family) === cleanFamily(value),
                        true,
                      ),
                    )}
                  </>
                )}

                {/* Searching indicator */}
                {isSearching && (
                  <div className="flex items-center justify-center gap-1.5 py-3 text-[10px] text-[var(--text-muted)]">
                    <Loader2 size={10} className="animate-spin" />
                    Searching Google Fonts…
                  </div>
                )}
              </>
            ) : (
              // Grouped view (no search)
              <>
                {/* Recommended Section */}
                {recommended.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 px-1.5 py-1.5">
                      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
                      <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase tracking-wider shrink-0">
                        Recommended
                      </span>
                      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
                    </div>
                    {recommended.map((f: WebFont) =>
                      renderFontItem(
                        f,
                        cleanFamily(f.family) === cleanFamily(value),
                      ),
                    )}
                  </>
                )}

                {/* Primary Section */}
                {primary.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 px-1.5 py-1.5 mt-1">
                      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
                      <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase tracking-wider shrink-0">
                        All Fonts
                      </span>
                      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
                    </div>
                    {primary.map((f: WebFont) =>
                      renderFontItem(
                        f,
                        cleanFamily(f.family) === cleanFamily(value),
                      ),
                    )}
                  </>
                )}

                {/* Secondary (CJK) Section */}
                {secondary.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 px-1.5 py-1.5 mt-1">
                      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
                      <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase tracking-wider shrink-0">
                        More Languages
                      </span>
                      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
                    </div>
                    {secondary.map((f: WebFont) =>
                      renderFontItem(
                        f,
                        cleanFamily(f.family) === cleanFamily(value),
                      ),
                    )}
                  </>
                )}
              </>
            )}
          </div>

          {/* Footer hint */}
          <div className="px-2.5 py-1.5 border-t border-[var(--border-subtle)] text-[8px] text-[var(--text-muted)] flex items-center gap-1.5">
            <Download size={8} className="opacity-50" />
            <span>Fonts download on first use</span>
            <span className="mx-1">·</span>
            <Check size={8} className="text-emerald-400 opacity-60" />
            <span>Ready</span>
          </div>
        </div>
      )}
    </div>
  );
});

export default FontPicker;
