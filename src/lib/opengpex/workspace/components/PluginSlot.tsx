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

import React, { useMemo } from "react";
import {
  useEditorState,
  useEditorServices,
  PluginContext,
  usePluginList,
} from "@opengpex/editor/core/context";
import { EditorSlot, BuiltPlugin } from "@opengpex/editor/core/types";
import { PluginErrorBoundary } from "./PluginErrorBoundary";

interface PluginSlotProps {
  name: EditorSlot | EditorSlot[];
  className?: string;
  style?: React.CSSProperties;
  filter?: string; // New: support rendering contributions from a specific plugin ID only
  fallback?: React.ReactNode; // Let consumers define the skeleton layout
  children?: React.ReactNode;
}

/**
 * PluginSlot: Plugin mounting slot
 * Renders all plugin components registered to a specific location (Slot).
 * Enhanced: automatically inserts logical dividers when order crosses a multiple of 100.
 */
export default function PluginSlot({
  name,
  className,
  style,
  filter,
  fallback,
  children,
}: PluginSlotProps) {
  const { activeFrame } = useEditorState();
  const { plugins } = useEditorServices();
  const pluginList = usePluginList();

  const slotItems = useMemo(() => {
    const items: {
      id: string;
      Component: React.ComponentType;
      order: number;
      plugin: BuiltPlugin;
    }[] = [];
    const names = Array.isArray(name) ? name : [name];

    pluginList.forEach((p) => {
      // If filter is specified, only process that plugin
      if (filter && p.uid !== filter) return;

      // Use the unified visibility pre-check logic of PluginService
      if (!plugins.isPluginVisible(p, { hasActiveFrame: !!activeFrame }))
        return;

      // 1. Core mounted component (Primary component)
      if (names.includes(p.slot)) {
        items.push({
          id: p.uid,
          Component: p.component,
          order: p.order || 0,
          plugin: p,
        });
      }

      // 2. Contributed components (Contributed components)
      p.contributions?.forEach((contrib, index) => {
        if (names.includes(contrib.slot)) {
          items.push({
            id: `${p.uid}-contrib-${index}`,
            Component: contrib.component,
            order: contrib.order ?? (p.order || 0),
            plugin: p,
          });
        }
      });
    });

    return items.sort((a, b) => a.order - b.order);
  }, [pluginList, activeFrame, name, filter, plugins]);

  if (slotItems.length === 0) return <>{children}</>;

  return (
    <div className={className} style={style}>
      {slotItems.map((item, index) => {
        // Hundreds digit logical grouping check: render divider if order crosses a multiple of 100
        const prevItem = slotItems[index - 1];
        const shouldShowDivider =
          prevItem &&
          Math.floor(item.order / 100) > Math.floor(prevItem.order / 100);

        return (
          <React.Fragment key={item.id}>
            {shouldShowDivider && (
              <Divider slotName={Array.isArray(name) ? name[0] : name} />
            )}
            <PluginErrorBoundary pluginId={item.id}>
              <React.Suspense fallback={fallback || null}>
                <PluginContext.Provider value={item.plugin}>
                  {name === "OPTION_BAR" ? (
                    <div className="h-[34px] px-3.5 flex items-center bg-[var(--bg-panel)]/80 backdrop-blur-md border border-[var(--border-subtle)] first:rounded-l-full last:rounded-r-full shadow-lg">
                      <item.Component />
                    </div>
                  ) : (
                    <item.Component />
                  )}
                </PluginContext.Provider>
              </React.Suspense>
            </PluginErrorBoundary>
          </React.Fragment>
        );
      })}
    </div>
  );
}

/**
 * Divider: Built-in divider component, automatically adapts style based on slot location
 */
function Divider({ slotName }: { slotName: EditorSlot }) {
  // 1. Toolbar and its setting group: horizontal short line (more compact and clear)
  if (slotName === "TOOL_MENU" || slotName === "TOOL_SETTINGS") {
    return (
      <div className="slot-divider h-px w-5 bg-[var(--border-subtle)] mx-auto my-0.5" />
    );
  }

  // 2. Header options: vertical line (in carriage design, gaps are natural separators, no dividers needed)
  if (slotName === "OPTION_BAR") {
    return null;
  }

  // 3. Sidebar panel: wide horizontal line
  if (slotName === "SIDE_BAR") {
    return (
      <div className="slot-divider h-px w-full bg-[var(--border-subtle)] my-1.5" />
    );
  }

  return null;
}
