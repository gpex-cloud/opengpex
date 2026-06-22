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

import { useRef, useEffect } from "react";
import {
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import { usePluginInit } from "./hooks/usePluginInit";
import { useEditorStatus } from "./hooks/useEditorStatus";
import { useLayoutSync } from "./hooks/useLayoutSync";
import { getWorkspaceStyles } from "./Workspace.styles";
import Viewport from "@opengpex/editor/stage/viewport/Viewport";
import { LayoutProvider } from "./LayoutContext";
import { OptionBar } from "./components/OptionBar";
import PluginSlot from "./components/PluginSlot";

// --- Other UI Components ---
import { LandingPage } from "./components/LandingPage";
import { ViewportHUD } from "./components/ViewportHUD";
import { GlobalUI } from "./components/GlobalUI";
import ToolMenu from "./components/ToolMenu";
import ExtendButton from "./components/ExtendButton";
import FancyOverlay from "@opengpex/editor/widgets/FancyOverlay";
import DrawerBar from "./components/DrawerBar";

import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";
import HotkeyManager from "./components/HotkeyManager";

export function Workspace() {
  const { state } = useEditorState();
  const { actions } = useEditorServices();

  const status = useEditorStatus();
  const { activeFrameId, ui } = state;
  const { theme, activeSidebarIds, sidebarMode, isToolMenuPinned } = ui;

  // 1. Initialize system services (plugins, shortcuts)
  usePluginInit(actions);

  // 2. Real-time styling skeleton calculation
  const styles = getWorkspaceStyles(
    activeSidebarIds.length > 0,
    theme.config.insets,
    isToolMenuPinned,
  );

  const hasFrames = state.frames.order.length > 0;
  const midContainerRef = useRef<HTMLDivElement>(null);

  // 3. Top-level size perception logic (Workspace Heartbeat)
  // Follows EditorStatus timing: physical size syncing to global state is allowed only in READY state
  useEffect(() => {
    if (!midContainerRef.current || status !== "READY") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        // Sync physical size to Redux triggering layout stability logic only if editor is ready
        actions.updateViewSize({ w: width, h: height });
      }
    });

    observer.observe(midContainerRef.current);
    return () => observer.disconnect();
  }, [actions, status]); // Add status dependency to re-evaluate measurement permissions on state transitions

  return (
    <LayoutProvider
      viewportDim={state.ui.viewportDim}
      syncKey={`${activeFrameId}-${sidebarMode}`}
    >
      {/* [REFACTOR-Step2] LayoutSyncBridge: forwards LayoutContext.safeRect → Redux insets */}
      <LayoutSyncBridge />
      <div
        className={styles.root.className}
        style={styles.root.style}
      >
        {/* Global loading overlay */}
        <FancyOverlay
          isVisible={status === "BOOTING"}
          title="Initializing Workspace"
          subtitle="Hydrating editor state from storage..."
          style={{ zIndex: EDITOR_Z_INDEX.UI.POPOVER + 10 }}
        />

        {/* --- Drawer Bar (Left) --- */}
        <DrawerBar side="left" />

        {/* --- Tool Menu --- */}
        <div
          className={styles.toolMenu.className}
          style={styles.toolMenu.style}
        >
          <ToolMenu />
        </div>

        <div ref={midContainerRef} className={styles.midContainer.className}>
          {/* --- B. OptionBar --- */}
          <OptionBar isVisible={hasFrames} />

          {/* --- C. Core Viewport Area --- */}
          <div className={styles.stageWrapper.className}>
            {status === "READY" ? (
              hasFrames ? (
                <Viewport
                  key={`viewport-${activeFrameId}`}
                  frameId={activeFrameId!}
                />
              ) : (
                <LandingPage />
              )
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)]/50">
                <span className="text-[10px] font-bold tracking-[0.3em] uppercase italic animate-pulse">
                  Initializing...
                </span>
              </div>
            )}

            {/* Viewport Overlay (TL/TR/BL/BR/DOCK & VIEWPORT_OVERLAY) - add key to ensure UI resets synchronously on frame switches */}
            <ViewportHUD key={`hud-${activeFrameId}`} />

            {/* Global Dock Area - independent of Frame lifecycle to ensure interaction stability */}
            {hasFrames && (
              <PluginSlot
                name="DOCK"
                className="absolute inset-0 pointer-events-none"
                style={{ zIndex: EDITOR_Z_INDEX.UI.OVERLAY + 20 }}
              />
            )}
          </div>
        </div>

        {/* --- Drawer Bar (Right) --- */}
        <DrawerBar side="right" />

        {/* --- Extend Button (Plugin Slot) --- */}
        <div
          className={styles.xtendButton.className}
          style={styles.xtendButton.style}
        >
          <ExtendButton />
        </div>

        {/* --- F. System Auxiliary Components --- */}
        <GlobalUI />
        <PluginSlot name="ROOT_OVERLAY" />
        <HotkeyManager />
      </div>
    </LayoutProvider>
  );
}

/**
 * LayoutSyncBridge: invokes useLayoutSync inside the LayoutProvider subtree.
 * Renders nothing; exists solely to host the sync-effect hook.
 */
function LayoutSyncBridge() {
  useLayoutSync();
  return null;
}
