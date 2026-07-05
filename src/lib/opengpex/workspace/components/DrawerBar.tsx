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

import React from "react";
import {
  useEditorState,
  useEditorServices,
  usePluginList,
} from "@opengpex/editor/core/context";
import {
  BuiltPlugin,
  EditorData,
  EditorActions,
} from "@opengpex/editor/core/types";
import { getWorkspaceStyles, WorkspaceStyleItem } from "../Workspace.styles";
import { Sparkles, ChevronLeft, ChevronRight } from "lucide-react";
import {
  AnimatePresence,
  motion,
  Reorder,
  useDragControls,
} from "framer-motion";
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import PluginSlot from "./PluginSlot";

import { useLayout } from "../LayoutContext";
import { WORKSPACE_GEOMETRY } from "../Workspace.styles";
import { useDrawerReveal } from "../hooks/useDrawerReveal";

export default function DrawerBar({
  side = "right",
}: {
  side?: "left" | "right";
}) {
  const { state } = useEditorState();
  const { actions, plugins } = useEditorServices();
  const { ui } = state;
  const pluginList = usePluginList();
  const styles = getWorkspaceStyles(true, ui.theme.config.insets, ui.isToolMenuPinned);

  const { registerSlot, unregisterSlot, cornerBlocks } = useLayout();

  React.useEffect(() => {
    registerSlot({
      id: `drawerbar-${side}`,
      role: side === "left" ? "LEFT_PUSH" : "RIGHT_PUSH",
      width: WORKSPACE_GEOMETRY.DRAWER_BAR_WIDTH,
      height: 0,
    });
    return () => unregisterSlot(`drawerbar-${side}`);
  }, [side, registerSlot, unregisterSlot]);

  // 1. Get and sort plugins (with visibility pre-check)
  const sidebarPlugins = pluginList.filter((p) => {
    // Basic slot check
    const isSidebarPlugin =
      p.slot === "SIDE_BAR" ||
      p.contributions?.some((c) => c.slot === "SIDE_BAR");
    if (!isSidebarPlugin) return false;

    // Visibility policy check (syncs with PluginSlot.tsx logic)
    return plugins.isPluginVisible(p, {
      hasActiveFrame: !!state.activeFrameId,
    });
  });

  const sortedPlugins = React.useMemo(() => {
    let leftOrder: string[] = [];
    let rightOrder: string[] = [];

    if (Array.isArray(ui.sidebarOrder)) {
      rightOrder = ui.sidebarOrder;
    } else {
      leftOrder = ui.sidebarOrder?.left || [];
      rightOrder = ui.sidebarOrder?.right || [];
    }

    const orderForThisSide = side === "left" ? leftOrder : rightOrder;

    return [...sidebarPlugins]
      .filter((p) => {
        // If it is explicitly assigned to the current side
        if (orderForThisSide.includes(p.uid)) return true;

        // If it is explicitly assigned to the other side
        const otherOrder = side === "left" ? rightOrder : leftOrder;
        if (otherOrder.includes(p.uid)) return false;

        // If not assigned to either (e.g. new plugin, or empty state), default assign by side
        const pref = p.side === "left" ? "left" : "right";
        return pref === side;
      })
      .sort((a, b) => {
        const idxA = orderForThisSide.indexOf(a.uid);
        const idxB = orderForThisSide.indexOf(b.uid);

        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA === -1 && idxB === -1) return (a.order ?? 0) - (b.order ?? 0);

        if (idxA === -1) return 1;
        if (idxB === -1) return -1;
        return 0;
      });
  }, [sidebarPlugins, ui.sidebarOrder, side]);

  // [REFACTOR-Step1] Aggregate slot for the currently expanded sidebar panels on this side.
  // Width = DrawerBar self width (40px) + max(preferredWidth) among active panels on this side,
  // so that LayoutProvider's safeRect (and downstream insets) avoids being occluded by the panel.
  // Registered as a SINGLE aggregated slot (`drawerbar-active-${side}`) to avoid scattered
  // register/unregister races when multiple panels open/close simultaneously.
  const activePanelMaxWidth = React.useMemo(() => {
    const ids = ui.activeSidebarIds || [];
    let maxWidth = 0;
    for (const plugin of sortedPlugins) {
      if (!ids.includes(plugin.uid)) continue;
      const raw = plugin.initialConfig?.preferredWidth;
      const width = typeof raw === "number" && raw > 0 ? raw : 320;
      if (width > maxWidth) maxWidth = width;
    }
    return maxWidth;
  }, [sortedPlugins, ui.activeSidebarIds]);

  React.useEffect(() => {
    const slotId = `drawerbar-active-${side}`;
    if (activePanelMaxWidth > 0) {
      registerSlot({
        id: slotId,
        role: side === "left" ? "LEFT_PUSH" : "RIGHT_PUSH",
        width: WORKSPACE_GEOMETRY.DRAWER_BAR_WIDTH + activePanelMaxWidth,
        height: 0,
      });
    } else {
      unregisterSlot(slotId);
    }
    return () => unregisterSlot(slotId);
  }, [side, activePanelMaxWidth, registerSlot, unregisterSlot]);

  // 2. Auto-reveal engine — only for plugins with autoReveal rules on this side
  const revealPlugins = React.useMemo(
    () => sortedPlugins.filter((p) => !!p.autoReveal),
    [sortedPlugins]
  );
  useDrawerReveal(revealPlugins, state, actions);

  // 3. Interaction handling
  const clickTimer = React.useRef<NodeJS.Timeout | null>(null);
  const isDraggingRef = React.useRef(false);

  const handleToggle = (id: string) => {
    const currentIds = ui.activeSidebarIds || [];

    if (currentIds.includes(id)) {
      actions.updateUI({
        activeSidebarIds: currentIds.filter((i) => i !== id),
      });
    } else {
      actions.updateUI({
        activeSidebarIds: [...currentIds, id],
      });
    }
  };

  const handleIsolate = (id: string) => {
    actions.updateUI({ activeSidebarIds: [id] });
  };

  const handleCombinedClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();

    // If dragging, ignore clicks
    if (isDraggingRef.current) return;

    if (clickTimer.current) {
      // Double click detected
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      handleIsolate(id);
    } else {
      // First click
      clickTimer.current = setTimeout(() => {
        handleToggle(id);
        clickTimer.current = null;
      }, 250);
    }
  };

  const handleReorder = (newSortedPlugins: typeof sortedPlugins) => {
    const currentOrder = Array.isArray(ui.sidebarOrder)
      ? { left: [], right: ui.sidebarOrder }
      : ui.sidebarOrder || { left: [], right: [] };

    actions.updateUI({
      sidebarOrder: {
        ...currentOrder,
        [side]: newSortedPlugins.map((p) => p.uid),
      },
    });
  };

  const drawerBarClass = `${styles.drawerBar.className} ${
    side === "left"
      ? ui.isToolMenuPinned
        ? ""
        : "left-2"
      : "right-2"
  } border-[var(--border-subtle)]`;

  const customStyle =
    side === "left" && ui.isToolMenuPinned
      ? {
          ...styles.drawerBar.style,
          left: `${WORKSPACE_GEOMETRY.TOOL_MENU_WIDTH + 8}px`,
        }
      : styles.drawerBar.style;

  return (
    <div className={drawerBarClass} style={customStyle} data-drawer-bar={side}>
      {/* Full-height vertical scrolling container, does not block events in inactive areas */}
      <div
        className={`absolute top-0 bottom-0 w-[100vw] overflow-y-auto scrollbar-hide pointer-events-none z-[900] ${side === "left" ? "left-0" : "right-0"}`}
      >
        {/* Top: dynamic placeholder, automatically avoids corner blocking areas (such as expanded XTEND_SLOT) */}
        <div
          className="shrink-0 transition-all duration-300 ease-out"
          style={{
            height: `${Math.max(34, side === "right" ? cornerBlocks.topRight : cornerBlocks.topLeft)}px`,
          }}
        />

        {/* Drag sort container */}
        <Reorder.Group
          axis="y"
          values={sortedPlugins}
          onReorder={handleReorder}
          className={`flex-1 flex flex-col w-full pt-6 pointer-events-none gap-3 ${side === "left" ? "items-start" : "items-end"}`}
        >
          {sortedPlugins.map((plugin) => (
            <SidebarItem
              key={plugin.uid}
              plugin={plugin}
              ui={ui}
              actions={actions}
              styles={styles}
              handleCombinedClick={handleCombinedClick}
              isDraggingRef={isDraggingRef}
              side={side}
            />
          ))}
        </Reorder.Group>
      </div>

      {/* Bottom: settings button */}
      {/* <div className={styles.drawerBarFooterItem.className} onClick={() => {}} title="Settings">
      <Settings size={20} className="text-[var(--text-muted)] group-hover:text-[var(--text-main)] transition-colors" />
      </div> */}
    </div>
  );
}

/**
 * Sidebar sub-component
 */
function SidebarItem({
  plugin,
  ui,
  actions,
  styles,
  handleCombinedClick,
  isDraggingRef,
  side,
}: {
  plugin: BuiltPlugin;
  ui: EditorData["ui"];
  actions: EditorActions;
  styles: Record<string, WorkspaceStyleItem>;
  handleCombinedClick: (id: string, e: React.MouseEvent) => void;
  isDraggingRef: React.RefObject<boolean>;
  side: "left" | "right";
}) {
  const { plugins } = useEditorServices();
  const isActive = (ui.activeSidebarIds || []).includes(plugin.uid);
  const isBusy = plugins.isBusy(plugin.uid);
  const panelWidth = plugin.initialConfig?.preferredWidth || 320;
  const dragControls = useDragControls();

  const [measuredHeight, setMeasuredHeight] = React.useState<number>(34);
  const [isClosing, setIsClosing] = React.useState(false);
  const [isOpening, setIsOpening] = React.useState(false);
  const [prevActive, setPrevActive] = React.useState(isActive);
  const [isDragging, setIsDragging] = React.useState(false);

  if (isActive !== prevActive) {
    setPrevActive(isActive);
    if (isActive) {
      setIsOpening(true);
      setIsClosing(false);
    } else {
      setIsClosing(true);
      setIsOpening(false);
    }
  }

  const observerRef = React.useRef<ResizeObserver | null>(null);
  const panelRef = React.useCallback((node: HTMLDivElement | null) => {
    if (node) {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const height = entry.target.clientHeight;
          if (height > 0) {
            setMeasuredHeight(height);
          }
        }
      });
      observer.observe(node);
      observerRef.current = observer;
    } else {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    }
  }, []);

  const switchSide = (e: React.MouseEvent) => {
    e.stopPropagation();

    let leftOrder = Array.isArray(ui.sidebarOrder)
      ? []
      : ui.sidebarOrder?.left || [];
    let rightOrder = Array.isArray(ui.sidebarOrder)
      ? ui.sidebarOrder
      : ui.sidebarOrder?.right || [];

    if (side === "left") {
      leftOrder = leftOrder.filter((id: string) => id !== plugin.uid);
      rightOrder = [...rightOrder, plugin.uid];
    } else {
      rightOrder = rightOrder.filter((id: string) => id !== plugin.uid);
      leftOrder = [...leftOrder, plugin.uid];
    }

    actions.updateUI({
      sidebarOrder: { left: leftOrder, right: rightOrder },
    });
  };

  return (
    <Reorder.Item
      key={plugin.uid}
      value={plugin}
      dragControls={dragControls}
      dragListener={false}
      onDragStart={() => {
        setIsDragging(true);
        if (isDraggingRef.current !== undefined) isDraggingRef.current = true;
      }}
      onDragEnd={() => {
        setTimeout(() => {
          setIsDragging(false);
        }, 300); // Maintain z-index during snap-back layout animation
        setTimeout(() => {
          if (isDraggingRef.current !== undefined)
            isDraggingRef.current = false;
        }, 100);
      }}
      className="w-full flex shrink-0 relative pointer-events-none"
      style={{
        overflow: "visible",
        zIndex: isDragging ? 1000 : "auto",
      }}
    >
      <motion.div
        animate={{ height: isActive ? "auto" : 34 }}
        transition={{ duration: 0.3, ease: "easeInOut" }}
        onAnimationComplete={() => {
          if (isClosing) {
            setIsClosing(false);
          }
          if (isOpening) {
            setIsOpening(false);
          }
        }}
        className="w-full relative"
        style={{
          overflow: isActive ? "visible" : "hidden",
          height: isOpening ? 34 : isActive ? "auto" : isClosing ? measuredHeight : 34,
        }}
      >
        <AnimatePresence>
          {!isActive ? (
            <motion.div
              key="icon"
              layout={false}
              initial={{ opacity: 0, scale: 0.8, x: 20 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.8, x: 20, position: "absolute" }}
              transition={{ duration: 0.3 }}
              className={`w-full flex ${side === "left" ? "justify-start" : "justify-end"} pointer-events-none`}
            >
              <div
                className="flex justify-center w-[40px] pointer-events-auto cursor-pointer"
                onPointerDown={(e) => dragControls.start(e)}
              >
                <Tooltip
                  content={plugin.manifest?.displayName || plugin.uid}
                  position={side === "left" ? "right" : "left"}
                  align="center"
                >
                  <DrawerItem
                    icon={plugin.icon || <Sparkles size={18} />}
                    active={false}
                    busy={isBusy}
                    onClick={(e) => handleCombinedClick(plugin.uid, e)}
                    label={plugin.manifest?.displayName || plugin.uid}
                    styles={styles}
                    side={side}
                  />
                </Tooltip>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="panel"
              layout={false}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, position: "absolute" }}
              transition={{ duration: 0.3 }}
              className={`w-full flex ${side === "left" ? "justify-start" : "justify-end"} relative pointer-events-none`}
            >
              {/* 2. Plugin panel */}
              <motion.div
                ref={panelRef}
                layout={false}
                initial={{
                  x: side === "left" ? -panelWidth : (panelWidth as number),
                  opacity: 0,
                }}
                animate={{ x: 0, opacity: 1 }}
                exit={{
                  x: (side === "left" ? -panelWidth : panelWidth) as number,
                  opacity: 0,
                }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className={`${styles.sidebarFloating.className} relative pointer-events-auto shrink-0`}
                style={{
                  width: `${panelWidth}px`,
                  zIndex: 900,
                  overflow: "visible", // Prevent clipping of the circular Switch Side button
                }}
              >
                <div
                  className={styles.sidebarInner.className}
                  style={{
                    paddingLeft: side === "left" ? "4px" : "12px",
                    paddingRight: side === "left" ? "12px" : "4px",
                  }}
                >
                  <PluginSlot
                    name="SIDE_BAR"
                    filter={plugin.uid}
                    fallback={<SidebarSkeleton />}
                  />
                </div>

                {/* 3. Side touch handle */}
                <div
                  className={`absolute top-0 bottom-0 w-4 cursor-grab active:cursor-grabbing z-[910] hover/5 group pointer-events-auto flex items-center justify-center ${side === "left" ? "right-0" : "left-0"}`}
                  onPointerDown={(e) => dragControls.start(e)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    actions.updateUI({ activeSidebarIds: [plugin.uid] });
                  }}
                  title="Double click to isolate | Drag to reorder"
                >
                  {/* Switch Side Button */}
                  <div
                    onClick={switchSide}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={`absolute top-5 w-[22px] h-[22px] rounded-full flex items-center justify-center bg-[var(--bg-panel)] border border-[var(--border-subtle)] shadow-md hover:bg-[var(--bg-stage)] hover:border-[var(--border-light)] transition-all duration-200 opacity-0 group-hover:opacity-100 pointer-events-auto cursor-pointer hover:scale-110 active:scale-95 ${
                      side === "left"
                        ? "right-0 translate-x-1/2"
                        : "left-0 -translate-x-1/2"
                    }`}
                    title={`Dock to ${side === "left" ? "Right" : "Left"}`}
                  >
                    {side === "left" ? (
                      <ChevronRight
                        size={14}
                        strokeWidth={2.5}
                        className="text-[var(--text-main)] hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                      />
                    ) : (
                      <ChevronLeft
                        size={14}
                        strokeWidth={2.5}
                        className="text-[var(--text-main)] hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                      />
                    )}
                  </div>

                  {/* Collapse Button */}
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      const currentIds = ui.activeSidebarIds || [];
                      actions.updateUI({
                        activeSidebarIds: currentIds.filter((id) => id !== plugin.uid),
                      });
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={`absolute top-12 w-[22px] h-[22px] rounded-full flex items-center justify-center bg-[var(--bg-panel)] border border-[var(--border-subtle)] shadow-md hover:bg-[var(--bg-stage)] hover:border-[var(--border-light)] transition-all duration-200 opacity-0 group-hover:opacity-100 pointer-events-auto cursor-pointer hover:scale-110 active:scale-95 ${
                      side === "left"
                        ? "right-0 translate-x-1/2"
                        : "left-0 -translate-x-1/2"
                    }`}
                    title="Collapse panel"
                  >
                    {side === "left" ? (
                      <ChevronLeft
                        size={14}
                        strokeWidth={2.5}
                        className="text-[var(--text-main)] hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                      />
                    ) : (
                      <ChevronRight
                        size={14}
                        strokeWidth={2.5}
                        className="text-[var(--text-main)] hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                      />
                    )}
                  </div>

                  <div className="w-[3px] h-8 bg-[var(--text-muted)] opacity-30 rounded-full transition-all group-hover:h-12 group-hover:opacity-60 group-hover:bg-[var(--text-main)]" />
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </Reorder.Item>
  );
}

function DrawerItem({
  icon,
  active,
  busy,
  onClick,
  styles,
  side,
}: {
  icon: React.ReactNode;
  active?: boolean;
  busy?: boolean;
  onClick: (e: React.MouseEvent) => void;
  label: string;
  styles: Record<string, WorkspaceStyleItem>;
  side?: "left" | "right";
}) {
  return (
    <div
      className={`${styles.drawerBarItem.className} ${active ? styles.drawerBarItemActive.className : "hover:bg-indigo-500 hover:text-white hover:border-indigo-500/50 hover:shadow-[0_0_12px_rgba(99,102,241,0.4)]"} group`}
      onClick={onClick}
    >
      <div
        className={`transition-all duration-300 group-hover:scale-110 ${active ? "scale-110" : ""} ${busy ? "drawer-icon-busy" : ""}`}
      >
        {icon}
      </div>
      {active && (
        <div
          className={`absolute bg-indigo-500 ${
            side === "left"
              ? "-left-2 top-2 bottom-2 w-1.5 rounded-full shadow-[0_0_10px_rgba(99,102,241,0.8)]"
              : "-right-2 top-2 bottom-2 w-1.5 rounded-full shadow-[0_0_10px_rgba(99,102,241,0.8)]"
          }`}
        />
      )}
    </div>
  );
}

/**
 * Premium Sidebar Skeleton
 */
function SidebarSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-3 w-full h-full animate-pulse pointer-events-none select-none">
      {/* Title bar skeleton */}
      <div className="flex items-center gap-3 mb-1 mt-1">
        <div className="w-5 h-5 rounded-[6px] bg-[var(--border-subtle)] " />
        <div className="h-3 w-20 rounded-full bg-[var(--border-subtle)] " />
      </div>

      {/* Option group skeleton */}
      <div className="flex flex-col gap-2">
        <div className="h-8 w-full rounded-xl bg-[var(--border-subtle)] " />
        <div className="h-8 w-full rounded-xl bg-[var(--border-subtle)] " />
        <div className="h-8 w-2/3 rounded-xl bg-[var(--border-subtle)] " />
      </div>

      {/* Large block skeleton (simulates list or tree structure) */}
      <div className="mt-4 flex flex-col gap-2">
        <div className="h-2 w-12 rounded-full bg-[var(--border-subtle)] mb-1" />
        <div className="h-10 w-full rounded-2xl bg-[var(--border-subtle)] " />
        <div className="h-10 w-full rounded-2xl bg-[var(--border-subtle)] " />
        <div className="h-10 w-full rounded-2xl bg-[var(--border-subtle)] " />
      </div>
    </div>
  );
}
