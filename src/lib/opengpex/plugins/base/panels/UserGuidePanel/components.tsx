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
import { BookOpen } from "lucide-react";
import { BuiltCommand } from "@opengpex/editor/core/types";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import { PopupPanel } from "@opengpex/editor/widgets/PopupPanel";
import TabSwitcher from "@opengpex/editor/widgets/TabSwitcher";
import { useUserGuide } from "./hooks";

/**
 * GuideTrigger: Mounted to TOOL_SETTINGS
 * Gets toggleCmd command handler via useUserGuide, eliminating hard-coded command strings.
 */
export function GuideTrigger() {
  const { toggleCmd, isActive } = useUserGuide();

  return (
    <div id="trigger-guide">
      <FancyButton
        onClick={() => toggleCmd?.execute()}
        active={isActive}
        title="Interaction Guide"
        tooltipPosition="right"
        iconOnly
        shape="rect"
        {...({ "data-panel-toggle": "guide" } as Record<string, string>)}
      >
        <BookOpen size={18} />
      </FancyButton>
    </div>
  );
}

/**
 * GuidePanel: Mounted to ROOT_OVERLAY
 * Displays two Tabs: Plugins (plugin commands) and Core / Advanced (core advanced commands)
 */
export function GuidePanel() {
  const {
    toggleCmd,
    isActive,
    panelPosition,
    pluginTabsData,
    advancedTabsData,
    getShortcutLabels,
  } = useUserGuide();

  const [activeTab, setActiveTab] = useState<"plugins" | "core">("plugins");

  const currentData =
    activeTab === "plugins" ? pluginTabsData : advancedTabsData;

  return (
    <PopupPanel
      isVisible={isActive}
      onClose={() => toggleCmd?.execute()}
      size="sm"
      title="Editor Guide"
      subTitle="Command Shortcuts"
      icon={<BookOpen size={18} />}
      anchor="trigger-guide"
      position={panelPosition}
      closeOnOutsideClick={false}
    >
      <div className="flex flex-col max-h-[500px] overflow-hidden">
        {/* Tab Switcher */}
        <TabSwitcher
          tabs={[
            { id: "plugins", label: "Plugins" },
            { id: "core", label: "Advanced" },
          ]}
          activeTab={activeTab}
          onTabChange={(id) => setActiveTab(id as "plugins" | "core")}
          size="sm"
        />

        {/* Content Wrapper */}
        <div className="p-4 flex flex-col flex-1 overflow-hidden min-h-[350px]">
          {/* Grouped Commands List */}
          <div className="flex-1 overflow-y-auto space-y-6 pr-1">
            {currentData.map((group) => (
              <div key={group.category}>
                <h5 className="text-[8px] font-black text-indigo-500 uppercase tracking-[0.2em] mb-2.5 flex items-center gap-1.5">
                  <span className="w-1 h-3 bg-indigo-500 rounded-full" />{" "}
                  {group.category}
                </h5>
                <div className="space-y-2 pl-1.5">
                  {group.commands.map((cmd: BuiltCommand, idx: number) => (
                    <div
                      key={`${cmd.uid}-${idx}`}
                      className="flex justify-between items-center text-[10px] group/item"
                    >
                      <span className="text-[var(--text-muted)] font-bold group-hover/item:text-[var(--text-main)] transition-colors uppercase tracking-tight">
                        {cmd.name}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {getShortcutLabels(cmd.uid).map(
                          (label: string, idx: number, arr: string[]) => (
                            <React.Fragment key={`${cmd.uid}-key-${idx}`}>
                              <span className="bg-[var(--bg-stage)] px-2 py-0.5 rounded border border-[var(--border-subtle)] text-[var(--text-main)] font-bold text-[9px] tabular-nums shadow-sm">
                                {label}
                              </span>
                              {idx < arr.length - 1 && (
                                <span className="text-[var(--text-muted)] opacity-50 text-[8px]">
                                  /
                                </span>
                              )}
                            </React.Fragment>
                          ),
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Bottom tip */}
          <div className="pt-4 mt-4 border-t border-[var(--border-subtle)] shrink-0">
            <p className="text-[9px] text-[var(--text-muted)] leading-relaxed font-bold italic uppercase tracking-tighter">
              Double-Click a layer in the panel to rename it. <br />
              Hold Space + Drag to pan canvas at any time.
            </p>
          </div>
        </div>
      </div>
    </PopupPanel>
  );
}
