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

/* eslint-disable react-hooks/set-state-in-effect */

"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Target,
  RotateCw,
  Sparkles,
  AlertCircle,
  Box,
  List,
  Maximize2,
  Compass,
  Move3d,
  LayoutDashboard,
} from "lucide-react";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import { PopupPanel } from "@opengpex/editor/widgets/PopupPanel";
import type { RegisteredSlot } from "@opengpex/editor/workspace/LayoutContext";
import type { EditorSlot } from "@opengpex/editor/core/types";
import { useLayoutInfo, useLayoutConfig, RuntimeSlotGroup, SlotAnalysis, ContributionItem } from "./hooks";
import type { LayerDefinition } from "./protocols";

/**
 * LayoutInfoComponent (Outer Controller):
 * Lightweight state subscriber that passes layout and slot analysis data to the memoized presenter.
 */
export function LayoutInfoComponent() {
  const info = useLayoutInfo();

  if (!info.isEnabled) return null;

  return (
    <LayoutInfoPanel
      layout={info.layout}
      viewportDim={info.viewportDim}
      slotsAnalysis={info.slotsAnalysis}
      slotGroups={info.slotGroups}
      layerStack={info.layerStack}
      slotToLayerMap={info.slotToLayerMap}
      layerToDefaultSlot={info.layerToDefaultSlot}
      onClose={() => info.toggleCmd?.execute()}
    />
  );
}

interface LayoutInfoPanelProps {
  layout: {
    registeredSlots: Record<string, RegisteredSlot>;
    safeRect: { x: number; y: number; w: number; h: number };
    status: string;
  };
  viewportDim: { w: number; h: number };
  slotsAnalysis: SlotAnalysis[];
  slotGroups: RuntimeSlotGroup[];
  layerStack: LayerDefinition[];
  slotToLayerMap: Record<string, string | null>;
  layerToDefaultSlot: Record<string, string>;
  onClose: () => void;
}

/**
 * LayoutInfoPanel (Presenter):
 * Wrapped in React.memo to shield it from rendering degradation.
 * Renders an incredibly rich developer workspace coordinate inspector.
 */
const LayoutInfoPanel = React.memo(function LayoutInfoPanel({
  layout,
  viewportDim,
  slotsAnalysis,
  slotGroups,
  layerStack,
  slotToLayerMap,
  layerToDefaultSlot,
  onClose,
}: LayoutInfoPanelProps) {
  // Custom View Mode: '2d' vs '3d_exploded'
  const [viewMode, setViewMode] = useState<"2d" | "3d_exploded">("3d_exploded");

  const [activeGroupId, setActiveGroupId] = useState<string>("stage_overlays");

  // Find current slot group
  const activeGroup =
    slotGroups.find((g) => g.id === activeGroupId) || slotGroups[2];

  // State for active slot tab under current selected group
  const [activeSlotTab, setActiveSlotTab] = useState<EditorSlot>("TL");

  // Ensure activeSlotTab matches one of the slots in the activeGroup
  useEffect(() => {
    if (!activeGroup.slots.includes(activeSlotTab)) {
      setActiveSlotTab(activeGroup.slots[0]);
    }
  }, [activeGroupId, activeGroup, activeSlotTab]);

  const [hoveredBlock, setHoveredBlock] = useState<string | null>(null);
  const [isExploding, setIsExploding] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [rotateAngles, setRotateAngles] = useState({ x: 52, z: -38 });
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [focusedLayer, setFocusedLayer] = useState<string | null>(null);
  const isDragging3D = useRef(false);
  const drag3DStart = useRef({ x: 0, y: 0, startPanX: 0, startPanY: 0 });
  const view3DElRef = useRef<HTMLDivElement | null>(null);

  // 3D pan drag handler (window-level move/up for smooth tracking)
  // Mouse drag = pan viewport
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging3D.current) return;
      const dx = e.clientX - drag3DStart.current.x;
      const dy = e.clientY - drag3DStart.current.y;
      setPanOffset({
        x: drag3DStart.current.startPanX + dx,
        y: drag3DStart.current.startPanY + dy,
      });
    };
    const handleMouseUp = () => {
      isDragging3D.current = false;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  /**
   * Native wheel event listener with { passive: false } to properly preventDefault.
   * This is required because:
   * 1. React's onWheel is registered as passive by default in modern browsers
   * 2. Passive listeners cannot call preventDefault()
   * 3. Without preventDefault(), Ctrl+wheel / pinch-to-zoom triggers browser page zoom
   *
   * Interaction model:
   * - Plain scroll (no modifier): ZOOM in/out (most intuitive for users)
   * - Shift+scroll: ROTATE the 3D view
   * - Ctrl/Meta+scroll (trackpad pinch): ZOOM (same as plain scroll, but prevents browser zoom)
   *
   * Uses a stable ref to avoid stale closure issues with the callback ref pattern.
   */
  const handleWheel3DRef = useRef<(e: WheelEvent) => void>(() => {});

  // Keep the wheel handler ref in sync with the latest closure values.
  // Must be inside useEffect (not render body) to comply with React's rule
  // that refs must not be accessed/mutated during render.
  useEffect(() => {
    handleWheel3DRef.current = (e: WheelEvent) => {
      // Always prevent default to block browser zoom and page scroll
      e.preventDefault();
      e.stopPropagation();

      if (e.shiftKey) {
        // Shift+scroll = 3D rotate
        setRotateAngles((prev) => ({
          x: Math.max(5, Math.min(85, prev.x + e.deltaY * 0.3)),
          z: prev.z + e.deltaX * 0.3,
        }));
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Meta+scroll = zoom (trackpad pinch gesture sends ctrlKey=true)
        setZoomScale((prev) =>
          Math.min(2.5, Math.max(0.4, prev - e.deltaY * 0.01)),
        );
      } else {
        // Plain scroll = zoom (most natural for mouse wheel users)
        setZoomScale((prev) =>
          Math.min(2.5, Math.max(0.4, prev - e.deltaY * 0.005)),
        );
      }
    };
  });

  // Stable wheel handler proxy that always delegates to the latest ref
  const stableWheelHandler = useRef((e: WheelEvent) => {
    handleWheel3DRef.current(e);
  });

  /**
   * Callback ref for the 3D container: attaches/detaches non-passive wheel listener
   * AND gesture event listeners (Safari/WebKit pinch-to-zoom) whenever the element
   * mounts/unmounts (handles conditional rendering correctly).
   *
   * KEY FIX: On macOS trackpad, pinch-to-zoom may fire native `gesturestart`/`gesturechange`
   * events (Safari/WebKit) which bypass the wheel handler entirely. We must intercept
   * these as well. Additionally, `touch-action: none` CSS is applied inline to prevent
   * the browser from interpreting touch/pinch gestures natively.
   */
  const gestureStartRef = useRef<(e: Event) => void>((e) => {
    e.preventDefault();
  });
  const gestureChangeRef = useRef<(e: Event) => void>((e) => {
    e.preventDefault();
    // GestureEvent has a `scale` property (Safari-only)
    const ge = e as unknown as { scale: number };
    if (ge.scale !== undefined) {
      setZoomScale((prev) =>
        Math.min(2.5, Math.max(0.4, prev * ge.scale)),
      );
    }
  });

  const view3DContainerRef = useCallback((el: HTMLDivElement | null) => {
    // Cleanup previous element
    if (view3DElRef.current) {
      view3DElRef.current.removeEventListener("wheel", stableWheelHandler.current);
      view3DElRef.current.removeEventListener("gesturestart", gestureStartRef.current);
      view3DElRef.current.removeEventListener("gesturechange", gestureChangeRef.current);
    }
    view3DElRef.current = el;
    // Attach to new element
    if (el) {
      el.addEventListener("wheel", stableWheelHandler.current, { passive: false });
      el.addEventListener("gesturestart", gestureStartRef.current, { passive: false } as AddEventListenerOptions);
      el.addEventListener("gesturechange", gestureChangeRef.current, { passive: false } as AddEventListenerOptions);
    }
  }, []);

  // Helper: compute layer opacity based on focus state
  const layerOpacity = (layerId: string, defaultOpacity: number = 1) => {
    if (focusedLayer) return focusedLayer === layerId ? 1 : 0.15;
    return defaultOpacity;
  };

  // Check if 3D view has been modified from defaults
  const is3DViewModified =
    zoomScale !== 1 ||
    rotateAngles.x !== 52 ||
    rotateAngles.z !== -38 ||
    panOffset.x !== 0 ||
    panOffset.y !== 0 ||
    focusedLayer !== null;

  const reset3DView = () => {
    setZoomScale(1);
    setRotateAngles({ x: 52, z: -38 });
    setPanOffset({ x: 0, y: 0 });
    setFocusedLayer(null);
  };

  const topBlock = Object.values(layout.registeredSlots).find(
    (s) => s.role === "TOP_PUSH",
  );
  const bottomBlock = Object.values(layout.registeredSlots).find(
    (s) => s.role === "BOTTOM_PUSH",
  );
  const leftBlock = Object.values(layout.registeredSlots).find(
    (s) => s.role === "LEFT_PUSH",
  );
  const rightBlock = Object.values(layout.registeredSlots).find(
    (s) => s.role === "RIGHT_PUSH",
  );

  const hasTopPush = !!topBlock;
  const hasBottomPush = !!bottomBlock;
  const hasLeftPush = !!leftBlock;
  const hasRightPush = !!rightBlock;

  // Find active slot statistics count
  const currentSlotAnalysis: SlotAnalysis = slotsAnalysis.find(
    (s) => s.name === activeSlotTab,
  ) || { name: activeSlotTab, items: [] };

  // Programmatic function to select a slot tab and its parent group
  const selectSlot = (slotName: string) => {
    const parentGroup = slotGroups.find((g) => g.slots.includes(slotName));
    if (parentGroup) {
      setActiveGroupId(parentGroup.id);
      setActiveSlotTab(slotName);
    }
  };

  // --- Bidirectional Synchronization (driven by dynamic slotToLayerMap & layerToDefaultSlot props) ---
  const isSyncing = useRef(false);

  // Sync: Registry Explorer -> 3D Layer Focus
  useEffect(() => {
    if (isSyncing.current) return;

    const targetLayer = slotToLayerMap[activeSlotTab];
    if (targetLayer !== undefined && targetLayer !== focusedLayer) {
      isSyncing.current = true;
      setFocusedLayer(targetLayer);
      setTimeout(() => {
        isSyncing.current = false;
      }, 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlotTab, slotToLayerMap]);

  // Sync: 3D Layer Focus -> Registry Explorer
  useEffect(() => {
    if (isSyncing.current || !focusedLayer) return;

    if (slotToLayerMap[activeSlotTab] === focusedLayer) return;

    const targetSlot = layerToDefaultSlot[focusedLayer];
    if (targetSlot) {
      const parentGroup = slotGroups.find((g) => g.slots.includes(targetSlot));
      if (parentGroup) {
        isSyncing.current = true;
        setActiveGroupId(parentGroup.id);
        setActiveSlotTab(targetSlot);
        setTimeout(() => {
          isSyncing.current = false;
        }, 50);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedLayer, layerToDefaultSlot, slotToLayerMap]);

  return (
    <PopupPanel
      isVisible={true}
      onClose={onClose}
      title="Blueprint Inspector"
      subTitle="Workspace Layout Registry"
      icon={<Target size={14} />}
      status={layout.status}
      mode="responsive"
      size="sm"
      position="BR"
      closeOnOutsideClick={false}
    >
      {(isExpanded) => (
        <>
          {/* RENDER MODE A: DASHBOARD EXPANDED VIEW (960px x 600px) */}
          {isExpanded ? (
            <div className="flex-1 min-h-0 flex gap-6 animate-in fade-in zoom-in-99 duration-300 p-5">
              {/* LEFT PANEL: COMPLETE BLUEPRINT VIEWPORT WIREFRAME MAP (with 3D perspective switch) */}
              <div className="w-[560px] flex flex-col gap-3.5 border-r border-[var(--border-subtle)] pr-6 flex-shrink-0">
                <div className="flex items-center justify-between text-[var(--text-main)] flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <Box size={12} className="text-[var(--text-muted)]" />
                    <span className="text-[11px] font-black uppercase tracking-tight">
                      Interactive Visual Blueprint
                    </span>
                  </div>

                  {/* 2D vs 3D Isometric View Mode Toggle */}
                  <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
                    <button
                      onClick={() => setViewMode("2d")}
                      className={`px-2 py-0.5 rounded text-[8px] font-black uppercase transition-all cursor-pointer ${
                        viewMode === "2d"
                          ? "bg-indigo-500 text-white shadow-sm"
                          : "text-[var(--text-muted)] hover"
                      }`}
                    >
                      2D View
                    </button>
                    <button
                      onClick={() => setViewMode("3d_exploded")}
                      className={`px-2 py-0.5 rounded text-[8px] font-black uppercase transition-all cursor-pointer flex items-center gap-1 ${
                        viewMode === "3d_exploded"
                          ? "bg-indigo-500 text-white shadow-sm"
                          : "text-[var(--text-muted)] hover"
                      }`}
                    >
                      <Move3d size={9} />
                      3D Exploded
                    </button>
                  </div>
                </div>

                {/* Complete proportional Workspace Blueprint (Dynamic 2D / Stacked Exploded 3D) */}
                <div className="w-full flex-1 border border-[var(--border-subtle)] rounded-2xl bg-[var(--bg-stage)] p-3 flex flex-col gap-1.5 overflow-hidden relative shadow-inner items-center justify-center">
                  {viewMode === "2d" ? (
                    /* ========================================================
 1. 2D BLUEPRINT VIEW MAPPING 
 ======================================================== */
                    <div className="w-full h-full flex flex-col gap-1.5 pointer-events-auto pr-10">
                      {/* OptionBar (TOP_PUSH) */}
                      <div
                        onMouseEnter={() => setHoveredBlock("top")}
                        onMouseLeave={() => setHoveredBlock(null)}
                        onClick={() => selectSlot("OPTION_BAR")}
                        className={`h-7 rounded-lg transition-all border flex items-center justify-center font-mono text-[8px] font-bold tracking-tight uppercase cursor-pointer ${
                          hoveredBlock === "top" ||
                          activeSlotTab === "OPTION_BAR" ||
                          focusedLayer === "chrome"
                            ? "bg-indigo-500/20 text-indigo-650 border-indigo-500/40 shadow-sm animate-[pulse_2s_infinite]"
                            : "bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-muted)]"
                        }`}
                      >
                        OptionBar (Height: {topBlock?.height || 48}px)
                      </div>

                      {/* Stage Viewport rows */}
                      <div className="flex-grow flex gap-1.5 min-h-0">
                        {/* Left ActivityBar layout block (LEFT_PUSH) */}
                        <div
                          onMouseEnter={() => setHoveredBlock("left")}
                          onMouseLeave={() => setHoveredBlock(null)}
                          className={`w-9 rounded-lg transition-all border flex flex-col items-center justify-center font-mono text-[7px] font-bold uppercase leading-none overflow-hidden ${
                            hoveredBlock === "left" ||
                            activeSlotTab === "SIDE_BAR" ||
                            focusedLayer === "chrome"
                              ? "bg-indigo-500/20 text-indigo-650 border-indigo-500/40 shadow-sm"
                              : "bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-muted)]"
                          }`}
                        >
                          <span
                            style={{
                              writingMode: "vertical-lr",
                              transform: "rotate(180deg)",
                            }}
                            className="whitespace-nowrap"
                          >
                            LeftBar ({leftBlock?.width || 52}px)
                          </span>
                        </div>

                        {/* Viewport Artboard Screen with corner nodes & floating tool menu */}
                        <div
                          onMouseEnter={() => setHoveredBlock("center")}
                          onMouseLeave={() => setHoveredBlock(null)}
                          className={`flex-grow rounded-lg transition-all border flex flex-col items-center justify-center font-mono text-[8px] gap-0.5 relative p-4 ${
                            hoveredBlock === "center"
                              ? "bg-emerald-500/[0.08] text-emerald-600 border-emerald-500/40"
                              : "bg-indigo-500/[0.03] border-indigo-500/10 text-indigo-600 "
                          }`}
                        >
                          {/* Interactive Floating Tool Menu indicator: Positions on Top-Left overlapping canvas */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              selectSlot("TOOL_MENU");
                            }}
                            className={`absolute top-2.5 left-2.5 w-16 h-6 rounded border text-[7.5px] font-black uppercase flex items-center justify-center gap-1 transition-all ${
                              activeSlotTab === "TOOL_MENU"
                                ? "bg-amber-500 border-amber-500 text-white shadow"
                                : "bg-amber-500/10 border-amber-500/35 text-amber-650 hover:bg-amber-500/25"
                            }`}
                            title="Tool Menu Float Overlay"
                          >
                            <Sparkles size={9} />
                            Float Menu
                          </button>

                          {/* TL Corner node */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              selectSlot("TL");
                            }}
                            className={`absolute top-2.5 left-20 w-8 h-6 rounded border text-[7px] font-black uppercase flex items-center justify-center transition-all ${
                              activeSlotTab === "TL" ||
                              focusedLayer === "overlays"
                                ? "bg-indigo-500 border-indigo-500 text-white shadow"
                                : "bg-[var(--bg-panel)]/90 border-[var(--border-subtle)] text-[var(--text-main)] hover:border-indigo-500"
                            }`}
                          >
                            TL(
                            {slotsAnalysis.find((s) => s.name === "TL")?.items
                              .length || 0}
                            )
                          </button>

                          {/* TR Corner node */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              selectSlot("TR");
                            }}
                            className={`absolute top-2.5 right-2.5 w-8 h-6 rounded border text-[7px] font-black uppercase flex items-center justify-center transition-all ${
                              activeSlotTab === "TR" ||
                              focusedLayer === "overlays"
                                ? "bg-indigo-500 border-indigo-500 text-white shadow"
                                : "bg-[var(--bg-panel)]/90 border-[var(--border-subtle)] text-[var(--text-main)] hover:border-indigo-500"
                            }`}
                          >
                            TR(
                            {slotsAnalysis.find((s) => s.name === "TR")?.items
                              .length || 0}
                            )
                          </button>

                          {/* BL Corner node */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              selectSlot("BL");
                            }}
                            className={`absolute bottom-2.5 left-2.5 w-8 h-6 rounded border text-[7px] font-black uppercase flex items-center justify-center transition-all ${
                              activeSlotTab === "BL" ||
                              focusedLayer === "overlays"
                                ? "bg-indigo-500 border-indigo-500 text-white shadow"
                                : "bg-[var(--bg-panel)]/90 border-[var(--border-subtle)] text-[var(--text-main)] hover:border-indigo-500"
                            }`}
                          >
                            BL(
                            {slotsAnalysis.find((s) => s.name === "BL")?.items
                              .length || 0}
                            )
                          </button>

                          {/* BR Corner node */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              selectSlot("BR");
                            }}
                            className={`absolute bottom-2.5 right-2.5 w-8 h-6 rounded border text-[7px] font-black uppercase flex items-center justify-center transition-all ${
                              activeSlotTab === "BR" ||
                              focusedLayer === "overlays"
                                ? "bg-indigo-500 border-indigo-500 text-white shadow"
                                : "bg-[var(--bg-panel)]/90 border-[var(--border-subtle)] text-[var(--text-main)] hover:border-indigo-500"
                            }`}
                          >
                            BR(
                            {slotsAnalysis.find((s) => s.name === "BR")?.items
                              .length || 0}
                            )
                          </button>

                          {/* DOCK Slot */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              selectSlot("DOCK");
                            }}
                            className={`absolute bottom-2.5 left-[50%] -translate-x-[50%] w-14 h-6 rounded border text-[7px] font-black uppercase flex items-center justify-center transition-all ${
                              activeSlotTab === "DOCK" ||
                              focusedLayer === "overlays"
                                ? "bg-indigo-500 border-indigo-500 text-white shadow"
                                : "bg-[var(--bg-panel)]/90 border-[var(--border-subtle)] text-[var(--text-main)] hover:border-indigo-500"
                            }`}
                          >
                            DOCK(
                            {slotsAnalysis.find((s) => s.name === "DOCK")?.items
                              .length || 0}
                            )
                          </button>

                          <span className="font-black text-[9px] uppercase tracking-wider mb-0.5 mt-[-6px]">
                            Canvas SafeRect
                          </span>
                          <span className="font-bold tabular-nums">
                            w: {layout.safeRect.w} × h: {layout.safeRect.h} px
                          </span>
                          <span className="text-[6.5px] opacity-60 leading-none">
                            Offset x: {layout.safeRect.x}, y:{" "}
                            {layout.safeRect.y}
                          </span>
                        </div>

                        {/* Right ActivityBar & Sidebar (RIGHT_PUSH) */}
                        <div
                          onMouseEnter={() => setHoveredBlock("right")}
                          onMouseLeave={() => setHoveredBlock(null)}
                          onClick={() => selectSlot("SIDE_BAR")}
                          className={`w-9 rounded-lg transition-all border flex flex-col items-center justify-center font-mono text-[7px] font-bold uppercase leading-none overflow-hidden cursor-pointer ${
                            hoveredBlock === "right" ||
                            activeSlotTab === "SIDE_BAR" ||
                            focusedLayer === "chrome"
                              ? "bg-indigo-500/20 text-indigo-650 border-indigo-500/40 shadow-sm"
                              : "bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-muted)]"
                          }`}
                        >
                          <span
                            style={{ writingMode: "vertical-rl" }}
                            className="whitespace-nowrap"
                          >
                            RightBar ({rightBlock?.width || 320}px)
                          </span>
                        </div>
                      </div>

                      {/* Bottom Dock push block */}
                      {hasBottomPush ? (
                        <div
                          onMouseEnter={() => setHoveredBlock("bottom")}
                          onMouseLeave={() => setHoveredBlock(null)}
                          onClick={() => selectSlot("DOCK")}
                          className={`h-6 rounded-lg transition-all border flex items-center justify-center font-mono text-[7.5px] font-bold uppercase cursor-pointer ${
                            hoveredBlock === "bottom" ||
                            activeSlotTab === "DOCK" ||
                            focusedLayer === "overlays"
                              ? "bg-indigo-500/20 text-indigo-650 border-indigo-500/40"
                              : "bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-muted)]"
                          }`}
                        >
                          Dock (Height: {bottomBlock?.height}px)
                        </div>
                      ) : (
                        <div className="h-1 bg-transparent" />
                      )}
                    </div>
                  ) : (
                    /* ========================================================
 2. 3D ISOMETRIC STACKED LAYER VIEW (WOW-Factor!)
 ======================================================== */
                    <div
                      ref={view3DContainerRef}
                      className={`w-full h-full flex items-center justify-center ${isDragging3D.current ? "cursor-grabbing" : "cursor-grab"}`}
                      style={{ perspective: "900px", touchAction: "none" }}
                      onMouseEnter={() => setIsExploding(true)}
                      onMouseLeave={() => setIsExploding(false)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        reset3DView();
                      }}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        const target = e.target as HTMLElement;
                        if (target.closest("button")) return;
                        e.stopPropagation();
                        e.preventDefault();
                        isDragging3D.current = true;
                        drag3DStart.current = {
                          x: e.clientX,
                          y: e.clientY,
                          startPanX: panOffset.x,
                          startPanY: panOffset.y,
                        };
                      }}
                    >
                      {/* Pan translation wrapper (screen-space) */}
                      <div
                        style={{
                          transform: `translate(${panOffset.x}px, ${panOffset.y}px)`,
                        }}
                      >
                        {/* Stacked Isometric container */}
                        <div
                          className="relative w-72 h-44 transition-transform duration-500 ease-out"
                          style={{
                            transform: `rotateX(${rotateAngles.x}deg) rotateZ(${rotateAngles.z}deg) translateY(-10px) scale(${zoomScale})`,
                            transformStyle: "preserve-3d",
                          }}
                        >
                          {/* L1: CONTENT (Z-Index 200) */}
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusedLayer((prev) =>
                                prev === "canvas" ? null : "canvas",
                              );
                            }}
                            className={`absolute inset-0 rounded-2xl bg-emerald-500/10 border-2 flex flex-col items-center justify-center text-emerald-600 font-mono text-[8px] transition-all duration-500 ease-out cursor-pointer ${focusedLayer === "canvas" ? "border-emerald-500 ring-1 ring-emerald-500/40" : "border-emerald-500/40"}`}
                            style={{
                              transform: `translateZ(${isExploding ? "-70px" : "0px"})`,
                              boxShadow:
                                focusedLayer === "canvas"
                                  ? "0 0 35px rgba(16,185,129,0.3)"
                                  : "0 10px 30px rgba(0,0,0,0.1)",
                              opacity: layerOpacity(
                                "canvas",
                                isExploding ? 0.6 : 1,
                              ),
                            }}
                          >
                            <span className="font-black tracking-widest text-[8.5px] uppercase">
                              Viewport Canvas
                            </span>
                            <span className="font-bold tabular-nums">
                              {layout.safeRect.w} × {layout.safeRect.h} px
                            </span>
                            <span className="text-[6.5px] opacity-75 mt-0.5 uppercase tracking-wide">
                              L1: 200 - CONTENT
                            </span>
                          </div>

                          {/* L2: STAGE_GIZMOS (Z-Index 1000) */}
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusedLayer((prev) =>
                                prev === "gizmos" ? null : "gizmos",
                              );
                            }}
                            className={`absolute inset-2 rounded-2xl bg-teal-500/[0.04] border border-dashed flex flex-col items-center justify-center transition-all duration-500 ease-out z-10 cursor-pointer overflow-hidden ${focusedLayer === "gizmos" ? "border-teal-500 ring-1 ring-teal-500/40" : "border-teal-500/30"}`}
                            style={{
                              transform: `translateZ(${isExploding ? "-30px" : "16px"})`,
                              opacity: layerOpacity(
                                "gizmos",
                                isExploding ? 0.8 : 1,
                              ),
                            }}
                          >
                            {/* Fake rotated grid background for gizmos */}
                            <div
                              className="absolute inset-[-50%] opacity-20 border border-teal-500/50 rotate-12"
                              style={{
                                backgroundImage:
                                  "linear-gradient(45deg, rgba(20,184,166,0.5) 25%, transparent 25%), linear-gradient(-45deg, rgba(20,184,166,0.5) 25%, transparent 25%)",
                                backgroundSize: "12px 12px",
                              }}
                            />
                            <span className="text-[7.5px] font-black text-teal-600 uppercase tracking-widest leading-none bg-teal-500/10 px-2 py-0.5 rounded-full z-10 shadow-sm backdrop-blur-sm border border-teal-500/20">
                              L2: 1000 - STAGE_GIZMOS
                            </span>
                          </div>

                          {/* L3: STAGE_OVERLAY & Corners (Z-Index 2000) */}
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusedLayer((prev) =>
                                prev === "overlays" ? null : "overlays",
                              );
                            }}
                            className={`absolute inset-1 rounded-2xl bg-indigo-500/[0.06] border border-dashed flex flex-col p-3 transition-all duration-500 ease-out z-20 cursor-pointer ${focusedLayer === "overlays" ? "border-indigo-500 ring-1 ring-indigo-500/40" : "border-indigo-500/30"}`}
                            style={{
                              transform: `translateZ(${isExploding ? "10px" : "32px"})`,
                              boxShadow:
                                focusedLayer === "overlays"
                                  ? "0 15px 35px rgba(99,102,241,0.35)"
                                  : "0 0 25px rgba(99,102,241,0.15)",
                              opacity: layerOpacity(
                                "overlays",
                                isExploding ? 0.9 : 1,
                              ),
                            }}
                          >
                            <div className="flex justify-between items-start z-10">
                              <div className="w-6 h-6 rounded bg-indigo-500 border border-indigo-500 text-white flex items-center justify-center text-[7px] font-black shadow-md">
                                TL
                              </div>
                              <div className="w-6 h-6 rounded bg-indigo-500 border border-indigo-500 text-white flex items-center justify-center text-[7px] font-black shadow-md">
                                TR
                              </div>
                            </div>
                            <div className="absolute top-6 bottom-6 left-10 right-10 border border-indigo-500 border-dashed flex flex-col items-center justify-center bg-indigo-500/[0.03]">
                              <div className="absolute -top-1 -left-1 w-1.5 h-1.5 bg-white border border-indigo-500" />
                              <div className="absolute -top-1 -right-1 w-1.5 h-1.5 bg-white border border-indigo-500" />
                              <div className="absolute -bottom-1 -left-1 w-1.5 h-1.5 bg-white border border-indigo-500" />
                              <div className="absolute -bottom-1 -right-1 w-1.5 h-1.5 bg-white border border-indigo-500" />
                              <span className="text-[7.5px] font-black text-indigo-600 uppercase tracking-widest leading-none bg-indigo-500/10 px-2 py-0.5 rounded-full backdrop-blur-sm border border-indigo-500/20 shadow-sm">
                                L3: 2000 - SYSTEM_TOOLS
                              </span>
                              <span className="text-[6px] font-black text-indigo-500/80 mt-1 uppercase tracking-widest">
                                STAGE_OVERLAY
                              </span>
                            </div>
                            <div className="flex justify-between items-end z-10 mt-auto">
                              <div className="w-6 h-6 rounded bg-indigo-500 border border-indigo-500 text-white flex items-center justify-center text-[7px] font-black shadow-md">
                                BL
                              </div>
                              <div className="w-10 h-5 rounded bg-indigo-500 border border-indigo-500 text-white flex items-center justify-center text-[6.5px] font-black shadow-md">
                                DOCK
                              </div>
                              <div className="w-6 h-6 rounded bg-indigo-500 border border-indigo-500 text-white flex items-center justify-center text-[7px] font-black shadow-md">
                                BR
                              </div>
                            </div>
                          </div>

                          {/* L4: OPTION_BAR & SIDE_BAR (Z-Index 2000) */}
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusedLayer((prev) =>
                                prev === "chrome" ? null : "chrome",
                              );
                            }}
                            className={`absolute inset-0 rounded-2xl bg-[var(--bg-panel)] border shadow-lg p-2.5 flex flex-col gap-1 text-[var(--text-muted)] transition-all duration-500 ease-out z-30 flex-shrink-0 cursor-pointer ${focusedLayer === "chrome" ? "border-amber-500 ring-1 ring-amber-500/40" : "border-[var(--border-subtle)]"}`}
                            style={{
                              transform: `translateZ(${isExploding ? "50px" : "48px"})`,
                              boxShadow:
                                focusedLayer === "chrome"
                                  ? "0 10px 30px rgba(245,158,11,0.25)"
                                  : "0 15px 35px rgba(0,0,0,0.15)",
                              opacity: layerOpacity(
                                "chrome",
                                isExploding ? 0.9 : 1,
                              ),
                            }}
                          >
                            <div className="h-5 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex items-center justify-center text-[7px] font-bold uppercase font-mono">
                              OPTION_BAR
                            </div>
                            <div className="flex-grow flex gap-1 min-h-0">
                              <div className="w-8 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex items-center justify-center text-[6px] font-black uppercase font-mono leading-none overflow-hidden">
                                <span
                                  style={{
                                    writingMode: "vertical-lr",
                                    transform: "rotate(180deg)",
                                  }}
                                  className="whitespace-nowrap"
                                >
                                  SIDE_BAR L
                                </span>
                              </div>
                              <div className="flex-grow border border-dashed border-[var(--border-subtle)] rounded-lg flex items-center justify-center text-[6px] font-bold uppercase text-[var(--text-muted)] font-mono">
                                Center Frame
                              </div>
                              <div className="w-8 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex items-center justify-center text-[6px] font-black uppercase font-mono leading-none overflow-hidden">
                                <span
                                  style={{ writingMode: "vertical-rl" }}
                                  className="whitespace-nowrap"
                                >
                                  SIDE_BAR R
                                </span>
                              </div>
                            </div>
                            <div className="text-[7px] text-[var(--text-muted)] font-bold uppercase tracking-widest text-center mt-0.5 leading-none">
                              L4: OPTION_BAR & SIDE_BAR
                            </div>
                          </div>

                          {/* L5: VIEWPORT_OVERLAY (Z-Index 4000) */}
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusedLayer((prev) =>
                                prev === "viewport" ? null : "viewport",
                              );
                            }}
                            className={`absolute inset-0 rounded-2xl bg-rose-500/[0.04] border border-dashed flex flex-col items-center justify-center transition-all duration-500 ease-out z-40 cursor-pointer ${focusedLayer === "viewport" ? "border-rose-500 ring-1 ring-rose-500/40" : "border-rose-500/30"}`}
                            style={{
                              transform: `translateZ(${isExploding ? "90px" : "64px"})`,
                              opacity: layerOpacity(
                                "viewport",
                                isExploding ? 0.9 : 1,
                              ),
                            }}
                          >
                            <div className="absolute inset-2 border-2 border-rose-500/20 rounded-xl pointer-events-none" />
                            <span className="font-black tracking-widest text-[8.5px] uppercase text-rose-600">
                              VIEWPORT_OVERLAY
                            </span>
                            <span className="text-[6.5px] opacity-75 mt-0.5 uppercase tracking-wide text-rose-600">
                              L5: 4000 - VIEWPORT_OVERLAY
                            </span>
                          </div>

                          {/* L6: ROOT_OVERLAY (Z-Index Highest) */}
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusedLayer((prev) =>
                                prev === "root" ? null : "root",
                              );
                            }}
                            className={`absolute -inset-2 rounded-[20px] bg-fuchsia-500/[0.02] border border-fuchsia-500/40 border-dashed flex flex-col items-center justify-start pt-2 transition-all duration-500 ease-out z-50 cursor-pointer ${focusedLayer === "root" ? "border-fuchsia-500 ring-1 ring-fuchsia-500/40 shadow-lg shadow-fuchsia-500/20" : ""}`}
                            style={{
                              transform: `translateZ(${isExploding ? "130px" : "80px"})`,
                              opacity: layerOpacity(
                                "root",
                                isExploding ? 0.9 : 1,
                              ),
                            }}
                          >
                            <div className="flex items-center gap-1 bg-fuchsia-500 text-white px-2 py-0.5 rounded text-[7px] font-black uppercase tracking-widest shadow-md">
                              <Maximize2 size={8} /> ROOT_OVERLAY
                            </div>
                            <span className="text-[6px] opacity-75 mt-1 uppercase tracking-wide text-fuchsia-600 font-bold">
                              L6: Window Global
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 3D Layer Focus Selector (Bottom Right) - Dynamically derived from layerStack */}
                  <div className="absolute right-3 bottom-10 flex flex-col gap-1.5 z-40 pointer-events-auto">
                    {[...layerStack].reverse().map((layer) => {
                      const c = layer.color; // e.g. "emerald", "teal", "indigo", "amber", "rose", "fuchsia"
                      const isFocused = focusedLayer === layer.id;
                      const isDimmed = focusedLayer !== null && !isFocused;
                      return (
                        <button
                          key={layer.id}
                          title={layer.title}
                          onClick={(e) => {
                            e.stopPropagation();
                            setFocusedLayer(isFocused ? null : layer.id);
                          }}
                          className={`flex items-center justify-center p-1.5 rounded-lg border backdrop-blur-md transition-all duration-300 ${
                            isFocused
                              ? `bg-${c}-500 text-white border-${c}-500 shadow-lg scale-105`
                              : isDimmed
                                ? "bg-[var(--bg-stage)]/50 text-[var(--text-muted)] border-transparent opacity-50"
                                : `bg-[var(--bg-panel)]/80 text-[var(--text-main)] border-[var(--border-subtle)] hover:border-${c}-500/50 hover:bg-${c}-500/10`
                          }`}
                        >
                          <div
                            className={`w-4 h-4 rounded flex items-center justify-center text-[7px] font-black shrink-0 ${
                              isFocused
                                ? "bg-white/20 text-white"
                                : `bg-${c}-500/20 text-${c}-500`
                            }`}
                          >
                            {layer.level}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Floating Hover Details & View Controls */}
                  <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between pointer-events-none">
                    <div className="text-[7px] font-black text-[var(--text-muted)] uppercase tracking-wide leading-none flex items-center gap-1">
                      <Compass size={8} />
                      {""}
                      {viewMode === "3d_exploded"
                        ? "Drag: pan · Scroll: zoom · ⇧Scroll: rotate · DblClick: reset · Click: focus"
                        : "2D interactive blueprint coordinates"}
                    </div>
                    {viewMode === "3d_exploded" && (
                      <div className="flex items-center gap-2">
                        <span className="text-[7px] font-black text-[var(--text-muted)] tabular-nums font-mono">
                          {Math.round(zoomScale * 100)}%
                        </span>
                        <span className="text-[6px] font-mono text-[var(--text-muted)] tabular-nums">
                          X:{Math.round(rotateAngles.x)}° Z:
                          {Math.round(rotateAngles.z)}°
                        </span>
                        {is3DViewModified && (
                          <button
                            onClick={reset3DView}
                            className="text-[7px] font-black text-indigo-500 uppercase hover:underline cursor-pointer flex items-center gap-0.5"
                          >
                            <RotateCw size={7} />
                            Reset
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Layout Block Sizing Details */}
                <div className="grid grid-cols-2 gap-2.5 text-[9px] font-mono flex-shrink-0">
                  <div className="p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                    <div className="text-[7.5px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none mb-1">
                      Browser Viewport
                    </div>
                    <div className="font-bold text-[var(--text-main)] tabular-nums">
                      W: {viewportDim.w} px
                    </div>
                    <div className="font-bold text-[var(--text-main)] tabular-nums">
                      H: {viewportDim.h} px
                    </div>
                  </div>

                  <div className="p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                    <div className="text-[7.5px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none mb-1">
                      SafeRect Boundaries
                    </div>
                    <div className="font-bold text-indigo-650 tabular-nums">
                      X: {layout.safeRect.x} px | Y: {layout.safeRect.y} px
                    </div>
                    <div className="font-bold text-indigo-650 tabular-nums">
                      W: {layout.safeRect.w} px | H: {layout.safeRect.h} px
                    </div>
                  </div>
                </div>
              </div>

              {/* RIGHT PANEL: 2-TIER SPATIAL CATEGORIZED SLOTS contributions DIRECTORY */}
              <div className="flex-grow flex flex-col gap-3.5 min-w-0">
                <div className="flex items-center justify-between text-[var(--text-main)] flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <List size={12} className="text-[var(--text-muted)]" />
                    <span className="text-[11px] font-black uppercase tracking-tight">
                      Slots Registry Explorer
                    </span>
                  </div>
                  <span className="text-[8.5px] font-mono text-[var(--text-muted)] bg-[var(--bg-stage)] px-2 py-0.5 rounded">
                    Total mounts:{""}
                    {slotsAnalysis.reduce((sum, s) => sum + s.items.length, 0)}
                  </span>
                </div>

                {/* TIER 1: Slot Group Tab Toggles (4 directions/regions) */}
                <div className="grid grid-cols-4 gap-1 p-0.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex-shrink-0">
                  {slotGroups.map((group) => {
                    const isActiveGroup = activeGroupId === group.id;
                    const totalGroupMounts = group.slots.reduce((sum, sn) => {
                      const data = slotsAnalysis.find((sa) => sa.name === sn);
                      return sum + (data?.items.length || 0);
                    }, 0);

                    return (
                      <button
                        key={group.id}
                        onClick={() => setActiveGroupId(group.id)}
                        className={`flex flex-col items-center justify-center py-1.5 px-1.5 rounded-lg transition-all text-center gap-1 cursor-pointer ${
                          isActiveGroup
                            ? "bg-[var(--bg-panel)] shadow-md text-[var(--text-main)] scale-[1.02] border border-indigo-500/30 ring-1 ring-indigo-500/10"
                            : "text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-panel)] border border-transparent"
                        }`}
                      >
                        <group.icon
                          size={11}
                          className={
                            isActiveGroup
                              ? "text-indigo-500"
                              : "text-[var(--text-muted)]"
                          }
                        />
                        <span className="text-[7.5px] font-black uppercase tracking-tighter truncate max-w-full">
                          {group.name}
                        </span>
                        <span
                          className={`text-[6.5px] font-black px-1.5 rounded-full ${
                            isActiveGroup
                              ? "bg-indigo-500 text-white"
                              : "bg-[var(--bg-panel)] text-[var(--text-muted)] border border-[var(--border-subtle)]"
                          }`}
                        >
                          {totalGroupMounts}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* TIER 2: Slot Selector Toggles under Active Group */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide border-b border-[var(--border-subtle)] flex-shrink-0 font-mono text-[9px] -mx-1 px-1">
                  {activeGroup.slots.map((slotName) => {
                    const isActiveSlot = activeSlotTab === slotName;
                    const count =
                      slotsAnalysis.find((sa) => sa.name === slotName)?.items
                        .length || 0;
                    return (
                      <button
                        key={slotName}
                        onClick={() => setActiveSlotTab(slotName)}
                        className={`flex items-center gap-1.5 py-1 px-2.5 rounded-lg border font-bold whitespace-nowrap transition-all flex-shrink-0 cursor-pointer ${
                          isActiveSlot
                            ? "bg-indigo-500 border-indigo-500 text-white shadow-md"
                            : "bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-main)] hover"
                        }`}
                      >
                        <span>{slotName}</span>
                        <span
                          className={`text-[7.5px] font-black px-1 py-0.5 rounded-full ${
                            isActiveSlot
                              ? "bg-[var(--bg-panel)] text-white"
                              : count > 0
                                ? "bg-indigo-500/10 text-indigo-650 "
                                : "bg-[var(--bg-stage)] text-[var(--text-muted)] "
                          }`}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Tab Panel Viewport: Mounted contributions list */}
                <div className="flex-1 overflow-y-auto space-y-2.5 pr-1.5 scrollbar-hide font-mono text-[9.5px]">
                  {currentSlotAnalysis.items.length > 0 ? (
                    currentSlotAnalysis.items.map((item: ContributionItem, idx: number) => (
                      <div
                        key={
                          item.pluginId +
                          "-" +
                          item.type +
                          "-" +
                          item.order +
                          "-" +
                          idx
                        }
                        className="p-3 rounded-2xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex items-center justify-between hover:border-[var(--border-light)] transition-all hover:bg-[var(--bg-stage)]"
                      >
                        <div className="flex flex-col gap-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                            <span className="font-black text-[10px] text-[var(--text-main)] truncate">
                              {item.pluginId}
                            </span>
                          </div>
                          <span className="text-[8px] text-[var(--text-muted)] uppercase font-black leading-none pl-3.5">
                            Mount: {item.type}
                            {""}
                            {item.showPolicy !== "ALWAYS_SHOW"
                              ? `| policy: ${item.showPolicy}`
                              : ""}
                          </span>
                        </div>

                        <span className="text-[8.5px] font-black text-indigo-650 uppercase tracking-wider bg-indigo-500/10 px-2 py-1 rounded-lg">
                          Order: {item.order}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="flex-grow flex flex-col items-center justify-center p-8 rounded-2xl bg-[var(--bg-stage)] border border-dashed border-[var(--border-subtle)] text-[var(--text-muted)] text-center uppercase tracking-wide py-12 gap-2">
                      <AlertCircle size={16} className="opacity-40" />
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[9px] font-black tracking-wider">
                          No Mounts In Slot
                        </span>
                        <span className="text-[7.5px] opacity-75 font-bold normal-case leading-relaxed">
                          No plugins or contributions have registered to mount
                          in the &quot;{activeSlotTab}&quot; slot region.
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* RENDER MODE B: HUD COMPACT VIEW (340px x 480px) */
            <div className="flex-grow flex flex-col gap-3.5 min-h-0 animate-in fade-in zoom-in-99 duration-300 p-5">
              {/* Blueprint map (Compact version) */}
              <div className="space-y-1.5 flex-shrink-0">
                <div className="flex items-center gap-2 text-[var(--text-main)] ">
                  <Box size={11} className="text-[var(--text-muted)]" />
                  <span className="text-[10px] font-black uppercase tracking-tight">
                    Blueprint Mini-Map
                  </span>
                </div>

                <div className="w-full h-[120px] border border-[var(--border-subtle)] rounded-2xl bg-[var(--bg-stage)] p-2 flex flex-col gap-1 overflow-hidden relative shadow-inner">
                  {/* OptionBar (TOP_PUSH) */}
                  {hasTopPush && (
                    <div className="h-5 rounded-md bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex items-center justify-center font-mono text-[7px] font-bold text-[var(--text-muted)] uppercase">
                      OptionBar ({topBlock?.height}px)
                    </div>
                  )}

                  {/* Middle Row */}
                  <div className="flex-grow flex gap-1 min-h-0">
                    {hasLeftPush && (
                      <div className="w-6 rounded-md bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex items-center justify-center font-mono text-[6.5px] font-bold text-[var(--text-muted)] uppercase">
                        <span className="rotate-[-90deg]">Left</span>
                      </div>
                    )}

                    <div className="flex-grow rounded-md bg-indigo-500/5 border border-indigo-500/10 flex flex-col items-center justify-center font-mono text-[7px] gap-0.5 text-indigo-600 relative">
                      {/* Tool Menu Small indicator */}
                      <div className="absolute top-1 left-1 px-1 rounded bg-amber-500 text-white text-[5px] font-black uppercase">
                        Float Menu
                      </div>
                      <span className="font-black text-[7.5px] uppercase mt-1">
                        Viewport
                      </span>
                      <span className="font-bold">
                        {layout.safeRect.w} × {layout.safeRect.h} px
                      </span>
                    </div>

                    {hasRightPush && (
                      <div className="w-6 rounded-md bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex items-center justify-center font-mono text-[6.5px] font-bold text-[var(--text-muted)] uppercase">
                        <span className="rotate-[90deg]">Right</span>
                      </div>
                    )}
                  </div>

                  {hasBottomPush && (
                    <div className="h-5 rounded-md bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex items-center justify-center font-mono text-[7px] font-bold text-[var(--text-muted)] uppercase">
                      Dock ({bottomBlock?.height}px)
                    </div>
                  )}
                </div>
              </div>

              {/* Simple registries */}
              <div className="grid grid-cols-2 gap-2 text-[9px] font-mono flex-shrink-0">
                <div className="p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] ">
                  <div className="text-[7.5px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none mb-1">
                    Viewport Dim
                  </div>
                  <div className="font-bold text-[var(--text-main)] tabular-nums">
                    {viewportDim.w}×{viewportDim.h} px
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] ">
                  <div className="text-[7.5px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none mb-1">
                    SafeRect Offset
                  </div>
                  <div className="font-bold text-indigo-650 tabular-nums">
                    X:{layout.safeRect.x} Y:{layout.safeRect.y} px
                  </div>
                </div>
              </div>

              {/* Slots contributions brief */}
              <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 scrollbar-hide border-t border-[var(--border-subtle)] pt-2.5 select-none font-mono text-[9px]">
                <div className="flex items-center justify-between text-[var(--text-main)] pb-1">
                  <div className="flex items-center gap-1.5">
                    <List size={11} className="text-[var(--text-muted)]" />
                    <span className="text-[9px] font-black uppercase tracking-tight">
                      Slot Brief Directory
                    </span>
                  </div>
                  <span className="text-[8px] font-black text-indigo-500/40 uppercase">
                    Expand for Details
                  </span>
                </div>

                {slotsAnalysis
                  .filter((s) => s.items.length > 0)
                  .map((slot) => (
                    <div
                      key={slot.name}
                      onClick={() => {
                        selectSlot(slot.name);
                      }}
                      className="p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex items-center justify-between hover /[0.02] cursor-pointer transition-all"
                    >
                      <span className="font-bold text-[var(--text-main)] uppercase tracking-tight">
                        {slot.name}
                      </span>
                      <span className="text-[8px] font-black text-indigo-500 uppercase tracking-wider bg-indigo-500/10 px-2 py-0.5 rounded-md font-mono">
                        {slot.items.length} Mounts
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}
    </PopupPanel>
  );
});

/**
 * LayoutInfoSettings: Toggles in Settings panel.
 */
export function LayoutInfoSettings() {
  const { isEnabled, toggleCmd } = useLayoutConfig();

  return (
    <>
      <FancyButton
        title="Editor Layout Blueprint"
        active={isEnabled}
        onClick={() => toggleCmd?.execute()}
        iconOnly
        shape="rect"
      >
        <LayoutDashboard size={14} />
      </FancyButton>
    </>
  );
}
