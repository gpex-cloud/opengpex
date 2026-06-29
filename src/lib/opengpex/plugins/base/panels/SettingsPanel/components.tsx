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

import { Settings } from "lucide-react";
import { PopupPanel } from "@opengpex/editor/widgets/PopupPanel";
import TabbedPluginSlot from "@opengpex/editor/workspace/components/TabbedPluginSlot";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import { useSettingsPanel } from "./hooks";

/**
 * SettingsTrigger: Mounted to TOOL_SETTINGS
 * Gets toggleCmd command handler via useSettingsPanel, eliminating hard-coded command strings.
 */
export function SettingsTrigger() {
  const { toggleCmd, isActive } = useSettingsPanel();

  return (
    <div id="trigger-settings">
      <FunctionButton
        onClick={() => toggleCmd?.execute()}
        active={isActive}
        title="Editor Settings"
        tooltipPosition="right"
        {...({ "data-panel-toggle": "settings" } as Record<string, string>)}
      >
        <Settings
          size={18}
          className={`transition-transform duration-500 ${isActive ? "rotate-90" : ""}`}
        />
      </FunctionButton>
    </div>
  );
}

/**
 * SettingsPanel: Mounted to ROOT_OVERLAY
 * Gets panel state and tab signals via useSettingsPanel, eliminating direct state access.
 */
export function SettingsPanel() {
  const { toggleCmd, isActive, panelPosition, activeTabId, tabSignal } =
    useSettingsPanel();

  return (
    <PopupPanel
      isVisible={isActive}
      onClose={() => toggleCmd?.execute()}
      title="Global Environment Settings"
      subTitle="Workspace Configurations"
      icon={<Settings size={18} />}
      anchor="trigger-settings"
      position={panelPosition}
      closeOnOutsideClick={false}
      scrollable={false}
      className="w-[750px] h-[640px] max-h-[720px]"
    >
      <div className="flex flex-col flex-1 min-h-0 p-4">
        <TabbedPluginSlot
          name="SETTINGS_CONFIG_PANEL"
          activeTabId={activeTabId}
          onTabChange={(tabId) => tabSignal?.set(tabId)}
        />
      </div>
    </PopupPanel>
  );
}
