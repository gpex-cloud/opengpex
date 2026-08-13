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

import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import {
  useEditorState,
  useEditorServices,
  PluginContext,
  usePluginList,
} from "@opengpex/editor/core/context";
import { EditorSlot, BuiltPlugin } from "@opengpex/editor/core/types";
import { PluginErrorBoundary } from "./PluginErrorBoundary";

export interface TabbedPluginSlotProps {
  name: EditorSlot | EditorSlot[];
  className?: string;
  style?: React.CSSProperties;
  defaultTitle?: string;
  contentClassName?: string;

  // Custom Renderers for flexibility
  renderHeader?: (
    tabs: Array<{ id: string; title: string; icon?: React.ReactNode }>,
    activeTabId: string,
    onTabChange: (id: string) => void,
  ) => React.ReactNode;
  renderContent?: (children: React.ReactNode) => React.ReactNode;

  activeTabId?: string;
  onTabChange?: (id: string) => void;
}

// Flattened intermediate data item structure
interface FlattenedItem {
  id: string;
  group: string; // Group ID (e.g. 'viewport', 'preferences')
  Component: React.ComponentType;
  title: string; // Display title / i18n translation key
  icon?: React.ReactNode;
  order: number;
  plugin: BuiltPlugin;
}

// Grouped Tab structure
interface TabGroup {
  id: string; // Group ID used for matching and active state
  title: string; // Display title on the Tab Bar
  icon?: React.ReactNode;
  order: number; // Minimum order of components in group
  components: {
    id: string;
    Component: React.ComponentType;
    order: number;
    plugin: BuiltPlugin;
  }[];
}

/**
 * TabbedPluginSlot - A tabbed UI slot renderer for plugin contributions.
 *
 * Architecture & Design Principles:
 *
 * 1. Role Separation between `group` (Group ID) and `title` (Display Label):
 *    - `group` (string): Invariant, language-neutral identifier used for tab grouping,
 *      state matching (`activeTabId`), and persistence (e.g. 'viewport', 'preferences', 'ai-tools').
 *      It MUST be a stable ASCII key and never changes across i18n locales.
 *    - `title` (string): Human-readable UI display label or i18n translation key (e.g. 'Viewport',
 *      'Preferences', 'AI Tools').
 *
 * 2. Cross-Plugin Tab Merging:
 *    - Contributions sharing the same `group` ID (e.g. TabDock and ClipOverlay both setting `group: 'viewport'`)
 *      are automatically merged into the SAME tab container on the UI.
 *
 * 3. Display Title & Icon Precedence:
 *    - For merged tabs, the tab display title and icon are derived from the contribution with the highest
 *      priority (smallest `order` value). If the highest-priority item provides no icon, it falls back to
 *      the next highest-priority contribution that provides one.
 */
export default function TabbedPluginSlot({
  name,
  className = "",
  style,
  defaultTitle = "General",
  contentClassName = "flex flex-col gap-4 min-h-0", // Default vertical spacing layout
  renderHeader,
  renderContent,
  activeTabId,
  onTabChange,
}: TabbedPluginSlotProps) {
  const { state } = useEditorState();
  const { plugins } = useEditorServices();
  const pluginList = usePluginList();
  const [internalActiveTabId, setInternalActiveTabId] = useState<string | null>(
    activeTabId || null,
  );
  const [prevActiveTabId, setPrevActiveTabId] = useState<string | undefined>(
    activeTabId,
  );

  if (activeTabId !== prevActiveTabId) {
    setPrevActiveTabId(activeTabId);
    if (activeTabId) {
      setInternalActiveTabId(activeTabId);
    }
  }

  const tabs = useMemo(() => {
    const activeFrame = state.activeFrameId
      ? state.frames.byId[state.activeFrameId]
      : undefined;
    const flatItems: FlattenedItem[] = [];

    // 1. Collect all matching contributions and core components
    pluginList.forEach((p) => {
      if (!plugins.isPluginVisible(p, { hasActiveFrame: !!activeFrame }))
        return;

      // Core mounted component
      if (p.slot === name) {
        flatItems.push({
          id: p.uid,
          group: p.group || p.uid,
          title:
            (p as unknown as { title?: string }).title ||
            p.manifest.displayName ||
            defaultTitle,
          Component: p.component,
          icon: p.icon,
          order: p.order || 0,
          plugin: p,
        });
      }

      // Contributed components
      p.contributions?.forEach((contrib, index) => {
        if (contrib.slot === name) {
          flatItems.push({
            id: `${p.uid}-contrib-${index}`,
            group: contrib.group || p.group || p.uid,
            title: contrib.title || (p as unknown as { title?: string }).title || p.manifest.displayName || defaultTitle,
            Component: contrib.component,
            icon: contrib.icon,
            order: contrib.order ?? (p.order || 0),
            plugin: p,
          });
        }
      });
    });

    // 2. Execute grouping logic (using group as invariant ID key, title as UI display text)
    const groupMap = new Map<string, TabGroup>();

    flatItems.forEach((item) => {
      const targetKey = item.group;

      if (!groupMap.has(targetKey)) {
        groupMap.set(targetKey, {
          id: targetKey,
          title: item.title,
          icon: item.icon,
          order: item.order,
          components: [],
        });
      }

      const currentGroup = groupMap.get(targetKey)!;

      // Prefer title and order of the highest-priority component (smallest order)
      if (item.order < currentGroup.order) {
        currentGroup.order = item.order;
        currentGroup.title = item.title;
        if (item.icon) {
          currentGroup.icon = item.icon;
        }
      } else if (!currentGroup.icon && item.icon) {
        currentGroup.icon = item.icon;
      }

      currentGroup.components.push({
        id: item.id,
        Component: item.Component,
        order: item.order,
        plugin: item.plugin,
      });
    });

    // 3. Sorting: sort components inside each Tab by order, and sort all Tabs by their minimum order
    const sortedTabs = Array.from(groupMap.values()).map((tab) => {
      tab.components.sort((a, b) => a.order - b.order);
      return tab;
    });

    return sortedTabs.sort((a, b) => a.order - b.order);
  }, [
    pluginList,
    state.frames,
    state.activeFrameId,
    name,
    defaultTitle,
    plugins,
  ]);

  // ─── Scroll state for tab bar overflow ─────────────────────────────────────
  const tabBarRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    const el = tabBarRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    checkScroll();
    const el = tabBarRef.current;
    if (!el) return;
    el.addEventListener('scroll', checkScroll);
    const ro = new ResizeObserver(checkScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', checkScroll);
      ro.disconnect();
    };
  }, [checkScroll, tabs.length]);

  const scrollTabs = useCallback((direction: 'left' | 'right') => {
    const el = tabBarRef.current;
    if (!el) return;
    el.scrollBy({ left: direction === 'left' ? -120 : 120, behavior: 'smooth' });
  }, []);

  if (tabs.length === 0) return null;

  // Ensure valid tab (supports matching by ID or title)
  let activeTab =
    tabs.find(
      (t) => t.id === internalActiveTabId || t.title === internalActiveTabId,
    ) || tabs.find((t) => t.id === activeTabId || t.title === activeTabId);
  if (!activeTab) activeTab = tabs[0];

  const defaultHeader = (
    <div className="relative flex items-center mb-4">
      {/* Left scroll arrow */}
      {canScrollLeft && (
        <button
          onClick={() => scrollTabs('left')}
          className="absolute left-0 z-10 w-6 h-full flex items-center justify-center bg-gradient-to-r from-[var(--bg-panel)] to-transparent text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
          aria-label="Scroll tabs left"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M7 1L3 5L7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      )}

      {/* Tab buttons (scrollable) */}
      <div
        ref={tabBarRef}
        className="flex items-center gap-1 p-1 bg-[var(--bg-stage)] rounded-xl overflow-x-auto scrollbar-none"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab && activeTab.id === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => {
                setInternalActiveTabId(tab.id);
                onTabChange?.(tab.id);
              }}
              className={`
 relative flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg transition-all duration-300 whitespace-nowrap shrink-0
 ${
   isActive
     ? "text-indigo-600 dark:text-indigo-400"
     : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
 }
`}
            >
              {isActive && (
                <div className="absolute inset-0 bg-[var(--bg-panel)] rounded-lg shadow-sm border border-[var(--border-subtle)] animate-in fade-in zoom-in-95 duration-200" />
              )}
              <span className="relative z-10 flex items-center gap-2">
                {tab.icon && <span className="scale-90">{tab.icon}</span>}
                <span className="text-[10px] font-black uppercase tracking-tight">
                  {tab.title}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Right scroll arrow */}
      {canScrollRight && (
        <button
          onClick={() => scrollTabs('right')}
          className="absolute right-0 z-10 w-6 h-full flex items-center justify-center bg-gradient-to-l from-[var(--bg-panel)] to-transparent text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
          aria-label="Scroll tabs right"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1L7 5L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      )}
    </div>
  );

  const defaultContent = (
    <div
      key={activeTab.id}
      className={`h-full animate-in fade-in slide-in-from-bottom-2 duration-300 ${contentClassName}`}
    >
      {/* Sequentially render all components in the current Tab */}
      {activeTab.components.map((comp) => {
        const Component = comp.Component;
        return (
          <PluginErrorBoundary key={comp.id} pluginId={comp.id}>
            <PluginContext.Provider value={comp.plugin}>
              <Component />
            </PluginContext.Provider>
          </PluginErrorBoundary>
        );
      })}
    </div>
  );

  const headerContent = renderHeader
    ? renderHeader(
        tabs.map((t) => ({ id: t.id, title: t.title, icon: t.icon })),
        activeTab.id,
        (id) => {
          setInternalActiveTabId(id);
          onTabChange?.(id);
        },
      )
    : defaultHeader;

  const mainContent = renderContent
    ? renderContent(defaultContent)
    : defaultContent;

  return (
    <div className={`flex flex-col h-full ${className}`} style={style}>
      {/* Tab Bar */}
      {headerContent}

      {/* Tab Content */}
      <div className="flex-1 relative min-h-0 overflow-y-auto custom-scrollbar">
        {mainContent}
      </div>
    </div>
  );
}
