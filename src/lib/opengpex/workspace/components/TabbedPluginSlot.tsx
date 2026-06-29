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
  Component: React.ComponentType;
  title: string;
  icon?: React.ReactNode;
  order: number;
  group?: string; // New: supported group field
  plugin: BuiltPlugin;
}

// Grouped Tab structure
interface TabGroup {
  id: string; // Group name if group exists, otherwise unique component ID
  title: string; // Title displayed on the Tab Bar
  icon?: React.ReactNode;
  order: number; // Minimum order of all components in the group, used to sort the entire Tab
  components: {
    id: string;
    Component: React.ComponentType;
    order: number;
    plugin: BuiltPlugin;
  }[];
}

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

      // Core mounted component (supports title / group / icon metadata)
      if (p.slot === name) {
        flatItems.push({
          id: p.uid,
          Component: p.component,
          title:
            (p as unknown as { title?: string }).title ||
            p.manifest.displayName ||
            defaultTitle,
          icon: p.icon,
          order: p.order || 0,
          group: p.group, // Supports core component defining a group
          plugin: p,
        });
      }

      // Contributed components
      p.contributions?.forEach((contrib, index) => {
        if (contrib.slot === name) {
          flatItems.push({
            id: `${p.uid}-contrib-${index}`,
            Component: contrib.component,
            title: contrib.title || defaultTitle,
            icon: contrib.icon,
            order: contrib.order ?? (p.order || 0),
            group: contrib.group, // Supports contributions defining a group
            plugin: p,
          });
        }
      });
    });

    // 2. Execute grouping logic (group priority)
    const groupMap = new Map<string, TabGroup>();

    flatItems.forEach((item) => {
      // Determines which key this item belongs to: uses group if configured, otherwise its own unique ID to be independent
      const targetKey = item.group || item.id;

      if (!groupMap.has(targetKey)) {
        groupMap.set(targetKey, {
          id: targetKey,
          // For explicit grouping, Tab title uses group name; for independent Tab, uses its own title
          title: item.group ? item.group : item.title,
          icon: item.icon, // Record the first encountered icon
          order: item.order, // Initial order
          components: [],
        });
      }

      const currentGroup = groupMap.get(targetKey)!;

      // Update minimum order within the group (for overall Tab sorting)
      if (item.order < currentGroup.order) {
        currentGroup.order = item.order;
      }
      // If group had no icon before but subsequent components do, complement it
      if (!currentGroup.icon && item.icon) {
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

  if (tabs.length === 0) return null;

  // Ensure valid tab (supports matching by ID or title)
  let activeTab =
    tabs.find(
      (t) => t.id === internalActiveTabId || t.title === internalActiveTabId,
    ) || tabs.find((t) => t.id === activeTabId || t.title === activeTabId);
  if (!activeTab) activeTab = tabs[0];

  const defaultHeader = (
    <div className="flex items-center gap-1 p-1 bg-[var(--bg-stage)] rounded-xl mb-4">
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
 relative flex-1 flex items-center justify-center gap-2 py-2 rounded-lg transition-all duration-300
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
