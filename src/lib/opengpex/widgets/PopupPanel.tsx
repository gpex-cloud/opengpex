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

/* eslint-disable react-hooks/set-state-in-effect */

import React, { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import { X, Maximize2, Minimize2 } from "lucide-react";
import { Motion } from "@opengpex/editor/core/motion";
import EditorPortal from "./Portal";
import { useEditorState } from "@opengpex/editor/core/context";

interface PopupPanelProps {
  isVisible: boolean;
  onClose: () => void;
  title: string;
  subTitle?: string;
  icon: React.ReactNode;
  children: React.ReactNode | ((isExpanded: boolean) => React.ReactNode);
  size?: "sm" | "md" | "lg";
  mode?: "fixed" | "responsive";
  defaultExpanded?: boolean;
  anchor?: string;
  anchorBottom?: number;
  anchorX?: number;
  className?: string;
  closeOnMouseLeave?: boolean;
  closeOnOutsideClick?: boolean;
  position?: "AN" | "CT" | "BL" | "BR";
  status?: "STABLE" | "MEASURING" | "NONE" | string;
  /** Optional content rendered in the header right area, before the close button */
  headerRight?: React.ReactNode;
}

export function PopupPanel({
  isVisible,
  onClose,
  title,
  subTitle,
  icon,
  children,
  size = "md",
  mode = "fixed",
  defaultExpanded = false,
  anchor,
  anchorBottom = 20,
  anchorX = 20,
  className = "",
  closeOnMouseLeave = false,
  closeOnOutsideClick = true,
  position,
  status = "NONE",
  headerRight,
}: PopupPanelProps) {
  const { state } = useEditorState();
  const panelRef = useRef<HTMLDivElement>(null);

  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const canToggle = mode === "responsive";
  const currentExpanded = mode === "fixed" ? size === "lg" : isExpanded;
  const hasActiveStatus = status && status !== "NONE";

  const [coords, setCoords] = useState<{
    x: number | string;
    b: number | string;
  }>({ x: "auto", b: "auto" });
  const [stackOffset, setStackOffset] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);
  const [active, setActive] = useState(false);

  const dragStartPos = useRef({ x: 0, y: 0 });
  const dragStartCoords = useRef({ x: 0, b: 0 });

  const finalPosition = position || (anchor ? "AN" : "CT");
  const leftInset = state.ui.theme.config.insets.left || 0;
  const rightInset = state.ui.theme.config.insets.right || 0;

  const recalculateStacking = useCallback(() => {
    if (!panelRef.current || !isVisible || hasDragged || finalPosition === "CT")
      return;

    const allPanels = Array.from(
      document.querySelectorAll(
        `.popup-panel-container[data-position="${finalPosition}"][data-visible="true"]`,
      ),
    ) as HTMLElement[];
    const myIndex = allPanels.indexOf(panelRef.current);

    if (myIndex <= 0) {
      setStackOffset(0);
      setIsReady(true);
      return;
    }

    let offset = 0;
    for (let i = 0; i < myIndex; i++) {
      offset += allPanels[i].offsetWidth + 16;
    }
    setStackOffset(offset);
    setIsReady(true);
  }, [isVisible, hasDragged, finalPosition]);

  useEffect(() => {
    if (mode === "responsive") {
      setIsExpanded(defaultExpanded);
    }
  }, [mode, defaultExpanded]);

  useEffect(() => {
    setHasDragged(false);
  }, [currentExpanded, size]);

  useEffect(() => {
    if (!isVisible) {
      setActive(false);
      setHasDragged(false);
      setStackOffset(0);
      setIsReady(false);
      return;
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (!closeOnOutsideClick) return;
      const target = e.target as HTMLElement;
      if (panelRef.current?.contains(target)) return;
      if (target.closest("[data-panel-toggle]")) return;
      if (target.closest(".popup-panel-container")) return;
      onClose();
    };

    const observer = new MutationObserver(() => recalculateStacking());
    const portalRoot = document.getElementById("editor-portal-root");
    if (portalRoot) {
      observer.observe(portalRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-visible"],
      });
    }

    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
      recalculateStacking();
    }, 10);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isVisible, onClose, closeOnOutsideClick, finalPosition, recalculateStacking]);

  useLayoutEffect(() => {
    if (isVisible && !hasDragged) {
      if (finalPosition === "BL") {
        setCoords({ x: anchorX + leftInset + stackOffset, b: anchorBottom });
      } else if (finalPosition === "BR") {
        const baseWidth = currentExpanded ? 1120 : size === "sm" ? 320 : 650;
        const w = panelRef.current?.offsetWidth || baseWidth;
        setCoords({
          x: window.innerWidth - w - anchorX - rightInset - stackOffset,
          b: anchorBottom,
        });
      } else if (finalPosition === "AN" && anchor) {
        const anchorEl = document.getElementById(anchor);
        if (anchorEl) {
          const rect = anchorEl.getBoundingClientRect();
          setCoords({
            x: rect.right + 20 + stackOffset,
            b: Math.max(20, window.innerHeight - rect.bottom),
          });
        }
      } else if (finalPosition === "CT") {
        setCoords({ x: "auto", b: "auto" });
      }

      if (isReady || finalPosition === "CT") {
        setActive(true);
      }
    }
  }, [
    isVisible,
    anchor,
    anchorX,
    anchorBottom,
    finalPosition,
    leftInset,
    rightInset,
    hasDragged,
    stackOffset,
    isReady,
    currentExpanded,
    size,
  ]);

  useEffect(() => {
    if (active && panelRef.current) {
      const initialX =
        finalPosition === "CT" ? 0 : finalPosition === "BR" ? 20 : -20;
      Motion.fromTo(
        panelRef.current,
        {
          opacity: 0,
          x: initialX,
          y: finalPosition === "CT" ? 20 : 0,
          scale: 0.95,
        },
        {
          opacity: 1,
          x: 0,
          y: 0,
          scale: 1,
          duration: 0.4,
          ease: "expo.out",
          overwrite: "auto",
        },
      );
    } else if (!isVisible && panelRef.current) {
      const targetX =
        finalPosition === "CT" ? 0 : finalPosition === "BR" ? 20 : -20;
      Motion.to(panelRef.current, {
        opacity: 0,
        x: targetX,
        y: finalPosition === "CT" ? 20 : 0,
        scale: 0.95,
        duration: 0.3,
        ease: "power2.inOut",
        overwrite: "auto",
      });
    }
  }, [active, isVisible, finalPosition]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!panelRef.current) return;
    const target = e.target as HTMLElement;
    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest("select") ||
      target.closest("a")
    )
      return;

    if (finalPosition === "CT" && !hasDragged) {
      const rect = panelRef.current.getBoundingClientRect();
      setCoords({ x: rect.left, b: window.innerHeight - rect.bottom });
      setHasDragged(true);
    }

    setIsDragging(true);
    const rect = panelRef.current.getBoundingClientRect();
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    dragStartCoords.current = {
      x: rect.left,
      b: window.innerHeight - rect.bottom,
    };
    e.preventDefault();
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStartPos.current.x;
      const deltaY = e.clientY - dragStartPos.current.y;
      setCoords({
        x: dragStartCoords.current.x + deltaX,
        b: dragStartCoords.current.b - deltaY,
      });
      setHasDragged(true);
    };
    const handleMouseUp = () => setIsDragging(false);
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  if (!isVisible && !active) return null;

  const containerStyle: React.CSSProperties =
    finalPosition === "CT" && !hasDragged
      ? {
          position: "fixed",
          inset: 0,
          paddingLeft: `${leftInset}px`,
          paddingRight: `${rightInset}px`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
          zIndex: 150,
        }
      : {
          position: "fixed",
          zIndex: 150,
          pointerEvents: "none",
          bottom: coords.b,
          left: coords.x,
        };

  const getSizeClasses = () => {
    if (currentExpanded) return "w-[1120px] h-[720px] max-h-[720px]";
    switch (size) {
      case "sm":
        return "w-80 h-[480px] max-h-[480px]";
      case "lg":
        return "w-[1120px] h-[720px] max-h-[720px]";
      case "md":
      default:
        return "w-[650px] h-[550px] max-h-[550px]";
    }
  };

  const getStatusColor = (statusText: string) => {
    switch (statusText) {
      case "STABLE":
        return "bg-emerald-500/10 text-emerald-500";
      case "MEASURING":
        return "bg-amber-500/10 text-amber-500";
      default:
        return "bg-[var(--bg-stage)] text-[var(--text-muted)]";
    }
  };

  return (
    <EditorPortal>
      <div style={containerStyle}>
        <div
          ref={panelRef}
          onMouseLeave={() => {
            if (closeOnMouseLeave && !isDragging) onClose();
          }}
          style={{ opacity: active ? 1 : 0 }}
          className={`
            bg-[var(--bg-panel)]/95 backdrop-blur-2xl border border-[var(--border-subtle)] 
            rounded-3xl shadow-2xl pointer-events-auto flex flex-col popup-panel-container 
            transition-all duration-500 overflow-hidden
            ${isDragging ? "select-none ring-2 ring-indigo-500/35 cursor-grabbing shadow-indigo-500/10" : ""} 
            ${getSizeClasses()}
            ${className}
          `}
          data-position={finalPosition}
          data-visible={isVisible}
          data-role="ui"
        >
          {/* ========================================================
              1. Header with independent padding (now declares px-5 py-4)
             ======================================================== */}
          <div
            onMouseDown={handleMouseDown}
            className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)] flex-shrink-0 cursor-grab active:cursor-grabbing hover:bg-[var(--bg-stage)] transition-colors"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {hasActiveStatus && (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${status === "STABLE" ? "bg-emerald-400" : "bg-amber-400"}`}
                  />
                  <span
                    className={`relative inline-flex rounded-full h-2 w-2 ${status === "STABLE" ? "bg-emerald-500" : "bg-amber-500"}`}
                  />
                </span>
              )}

              <div className="w-5 h-5 rounded-full bg-indigo-500/10 flex items-center justify-center shrink-0">
                <span className="text-indigo-500 scale-75">{icon}</span>
              </div>

              <div className="flex flex-col min-w-0">
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--text-main)] font-mono pointer-events-none truncate">
                  {title}
                </span>
                {subTitle && (
                  <span className="text-[7.5px] text-[var(--text-muted)] font-bold uppercase tracking-wide leading-none mt-0.5 pointer-events-none truncate">
                    {subTitle}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2.5 flex-shrink-0">
              {hasActiveStatus && (
                <span
                  className={`text-[8.5px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md font-mono ${getStatusColor(status)}`}
                >
                  {status}
                </span>
              )}

              {canToggle && (
                <button
                  onClick={() => setIsExpanded(!isExpanded)}
                  className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)] transition-colors"
                >
                  {isExpanded ? (
                    <Minimize2 size={13} />
                  ) : (
                    <Maximize2 size={13} />
                  )}
                </button>
              )}

              {headerRight && (
                <>
                  {headerRight}
                  <div className="w-px h-4 bg-[var(--border-subtle)]" />
                </>
              )}

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)] transition-colors"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* ========================================================
              2. Absolutely pure content area (padding completely determined by children)
             ======================================================== */}
          <div className="flex-1 min-h-0 relative flex flex-col custom-scrollbar overflow-y-auto">
            {typeof children === "function"
              ? children(currentExpanded)
              : children}
          </div>
        </div>
      </div>
    </EditorPortal>
  );
}
