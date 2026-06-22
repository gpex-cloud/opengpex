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

import React, { useEffect } from "react";
import { useEditorState } from "@opengpex/editor/core/context";
import { useLayout } from "../LayoutContext";
import { getWorkspaceStyles } from "../Workspace.styles";
import PluginSlot from "./PluginSlot";

interface OptionBarProps {
  isVisible: boolean;
}

export function OptionBar({ isVisible }: OptionBarProps) {
  const { state } = useEditorState();
  const { registerSlot, unregisterSlot } = useLayout();

  const { activeSidebarIds, theme, isToolMenuPinned } = state.ui;

  const styles = getWorkspaceStyles(
    activeSidebarIds.length > 0,
    theme.config.insets,
    isToolMenuPinned,
  );

  useEffect(() => {
    if (isVisible) {
      registerSlot({
        id: "optionbar",
        role: "TOP_PUSH",
        width: 0,
        height: 48, // Header height is 48px
      });
    } else {
      unregisterSlot("optionbar");
    }
    return () => {
      unregisterSlot("optionbar");
    };
  }, [isVisible, registerSlot, unregisterSlot]);

  if (!isVisible) return null;

  return (
    <div
      className={styles.topBarOuter.className}
      style={styles.topBarOuter.style}
    >
      <div className="flex items-center h-full pointer-events-auto w-full justify-center">
        <div className={styles.topBarInner.className}>
          <PluginSlot
            name="OPTION_BAR"
            className="flex items-center h-full gap-1"
          />
        </div>
      </div>
    </div>
  );
}
