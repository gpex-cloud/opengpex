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

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Moon,
  Sun,
  Monitor,
  Pin,
  PinOff,
  ChevronRight,
  Wrench,
} from "lucide-react";
import {
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import { useTheme } from "@opengpex/components/theme/ThemeContext";
// Import isolated local styles
import { getToolMenuStyles } from "../styles//ToolMenu.styles";
import PluginSlot from "./PluginSlot";
import Tooltip from "../../widgets/Tooltip";

// --- 1. Define infinitely recursive menu item data structure ---
interface MenuItemData {
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  onClick?: () => void;
  children?: MenuItemData[];
  slotName?: string | string[]; // ✨ New: supports rendering third-party plugin slots directly as submenu panels!
}

// --- 2. Native atomic menu item component (immune to outer style pollution) ---
function NativeMenuItem({
  data,
  styles,
  isPinned = false,
}: {
  data: MenuItemData;
  styles: ReturnType<typeof getToolMenuStyles>;
  isPinned?: boolean;
}) {
  const [activeSubMenu, setActiveSubMenu] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Determine if the current item contains submenus (either static children or dynamically injected slots)
  const hasSubMenu =
    (data.children && data.children.length > 0) || !!data.slotName;
  const isOpen = activeSubMenu === data.label;

  const handleMouseEnter = () => {
    if (!hasSubMenu) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setActiveSubMenu(data.label);
  };

  const handleMouseLeave = () => {
    if (!hasSubMenu) return;
    timeoutRef.current = setTimeout(() => {
      setActiveSubMenu(null);
    }, 150);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const buttonContent = (
    <button
      onClick={(e) => {
        if (data.onClick) {
          e.stopPropagation();
          data.onClick();
        }
      }}
      className={`${styles.menuItem.button} ${isOpen ? "bg-[var(--bg-stage)]" : ""}`}
    >
      <div className={styles.menuItem.icon}>{data.icon}</div>
      <span className={styles.menuItem.label}>{data.label}</span>
      {data.shortcut && (
        <span className={styles.menuItem.shortcut}>{data.shortcut}</span>
      )}

      {/* If there is a submenu (including slot), show right arrow */}
      {hasSubMenu && !isPinned && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-60">
          <ChevronRight size={12} />
        </span>
      )}
    </button>
  );

  return (
    <div
      className="relative w-full"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {isPinned && !hasSubMenu ? (
        <Tooltip content={data.label} position="right" align="center" display="block">
          {buttonContent}
        </Tooltip>
      ) : (
        buttonContent
      )}

      {/* --- Recursively mount next level cascade panel --- */}
      {hasSubMenu && isOpen && (
        <div
          className={styles.subMenuPanel.className}
          style={styles.subMenuPanel.style}
        >
          {/* ✨ If dynamic slot is configured, render PluginSlot directly here (removing outer wrapping div) */}
          {data.slotName && (
            <PluginSlot
              name={data.slotName}
              className={`suppress-tooltips ${styles.pluginSlotWrapper.className}`}
            />
          )}

          {/* If static children are configured, continue recursive rendering */}
          {data.children && data.children.length > 0 && (
            <div className="flex flex-col gap-0.5 px-2">
              {data.children.map((child) => (
                <NativeMenuItem
                  key={child.label}
                  data={child}
                  styles={styles}
                  isPinned={isPinned}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- 3. Core tool menu component ---
export default function ToolMenu() {
  const { state } = useEditorState();
  const { actions } = useEditorServices();
  const { theme: appTheme, switchTheme } = useTheme();
  const { ui } = state;
  const { isToolMenuPinned } = ui;

  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const isCollapsed = !(isOpen || isToolMenuPinned);
  const styles = getToolMenuStyles(isCollapsed, isToolMenuPinned);

  useEffect(() => {
    if (!isOpen || isToolMenuPinned) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const rafId = requestAnimationFrame(() =>
      document.addEventListener("mousedown", handleClickOutside),
    );
    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, isToolMenuPinned]);

  const toggleMenu = useCallback(() => {
    if (isToolMenuPinned) return;
    setIsOpen((prev) => !prev);
  }, [isToolMenuPinned]);

  const togglePin = useCallback(() => {
    actions.updateUI({ isToolMenuPinned: !isToolMenuPinned });
    setIsOpen(true);
  }, [isToolMenuPinned, actions]);

  const getAppThemeInfo = () => {
    if (appTheme === "light")
      return { icon: <Sun size={14} />, label: "Appearance: Light" };
    if (appTheme === "dark")
      return { icon: <Moon size={14} />, label: "Appearance: Dark" };
    return { icon: <Monitor size={14} />, label: "Appearance: System" };
  };

  const { icon: appThemeIcon, label: appThemeLabel } = getAppThemeInfo();

  return (
    <div ref={containerRef} className={styles.container.className}>
      {/* --- Header Row --- */}
      <div className={styles.header.className}>
        <button
          className={styles.trigger.className}
          onClick={isToolMenuPinned ? undefined : toggleMenu}
          style={isToolMenuPinned ? { cursor: "default" } : undefined}
        >
          <img
            src="/logo.svg"
            alt="Menu"
            className={`w-7 h-7 transition-all duration-300 ${!isCollapsed ? "rotate-315 brightness-125" : "rotate-0"}`}
          />
        </button>

        {!isCollapsed && (
          <>
            {!isToolMenuPinned && (
              <div className="flex flex-col items-start leading-tight gap-1 text-left animate-in fade-in slide-in-from-left-2 duration-300">
                <span className="text-[10px] font-black text-amber-600 tracking-[0.2em]">
                  OpenGPEX
                </span>
                <a
                  href="https://github.com/gpex-cloud/opengpex"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[9px] font-bold text-[var(--text-muted)] hover:text-amber-500 transition-colors"
                >
                  github.com/gpex-cloud/opengpex
                </a>
              </div>
            )}

            <button
              onClick={togglePin}
              className={`p-1.5 rounded-md transition-colors ${
                isToolMenuPinned
                  ? "text-amber-500 bg-amber-500/10 hover:bg-amber-500/20"
                  : "ml-auto text-[var(--text-muted)] hover:bg-[var(--bg-panel)]/40"
              }`}
            >
              {isToolMenuPinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
          </>
        )}
      </div>

      {/* --- Panel Content --- */}
      {!isCollapsed && (
        <div className="flex flex-col w-full origin-top-left animate-in fade-in slide-in-from-top-2 duration-300 pb-2">
          <div className={styles.divider.className} />

          {/* 1. Tool slot 1: TOOL_MENU */}
          <PluginSlot
            name="TOOL_MENU"
            className={`${isToolMenuPinned ? "" : "suppress-tooltips"} ${styles.topLevelPluginSlotWrapper.className}`}
          />

          <div className={styles.divider.className} />

          {/* 2. Editor Settings submenu (renders TOOL_SETTINGS slot internally) */}
          <div className="flex flex-col gap-0.5 px-2">
            <NativeMenuItem
              data={{
                label: "Help & Tooling",
                icon: <Wrench size={14} />,
                slotName: "TOOL_SETTINGS",
              }}
              styles={styles}
              isPinned={isToolMenuPinned}
            />
          </div>

          <div className={styles.divider.className} />

          {/* ✅ 4. Appearance toggle */}
          <div className="flex flex-col gap-0.5 px-2">
            <NativeMenuItem
              data={{
                label: "Switch Appearance",
                shortcut: appThemeLabel
                  .replace("Appearance: ", "")
                  .toUpperCase(),
                icon: appThemeIcon,
                onClick: () => switchTheme(),
              }}
              styles={styles}
              isPinned={isToolMenuPinned}
            />
          </div>
        </div>
      )}
    </div>
  );
}
