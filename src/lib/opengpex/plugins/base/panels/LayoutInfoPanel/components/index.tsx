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
  Target,
  Sparkles,
  AlertCircle,
  Box,
  List,
  Move3d,
  LayoutDashboard,
  ScanSearch,
  Grid2x2,
} from "lucide-react";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import { PopupPanel } from "@opengpex/editor/widgets/PopupPanel";
import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";
import type { EditorSlot } from "@opengpex/editor/core/types";
import { useLayoutInfo, useLayoutConfig, useRuntimeZAudit, SlotAnalysis, ContributionItem } from "../hooks";
import { SEGMENT_COLORS } from "../protocols";
import { SegmentStack3D, type SegmentSeatMap } from "./SegmentStack3D";
import { RuntimeZAudit } from "./RuntimeZAudit";

/**
 * Named seats per segment for the 3D stack, read from EDITOR_Z_INDEX so the
 * chips can never show a stale value.
 */
const SEAT_MAP: SegmentSeatMap = {
  stage: [
    { label: "CONTENT", value: EDITOR_Z_INDEX.STAGE.CONTENT },
    { label: "GIZMOS", value: EDITOR_Z_INDEX.STAGE.GIZMOS, annotated: "Inside the stageRef transform island — never competes outside the artboard" },
    { label: "OVERLAY", value: EDITOR_Z_INDEX.STAGE.OVERLAY },
    { label: "GUIDES", value: EDITOR_Z_INDEX.STAGE.GUIDES },
    { label: "FEEDBACK", value: EDITOR_Z_INDEX.STAGE.FEEDBACK },
    { label: "PLUGIN BAND", value: EDITOR_Z_INDEX.STAGE.PLUGIN_CANVAS, band: true },
  ],
  chrome: [
    { label: "DRAWER", value: EDITOR_Z_INDEX.CHROME.DRAWER_BAR },
    { label: "HUD CORNERS", value: EDITOR_Z_INDEX.CHROME.VIEWPORT_HUD },
    { label: "DOCK", value: EDITOR_Z_INDEX.CHROME.DOCK },
    { label: "FLOAT MENU", value: EDITOR_Z_INDEX.CHROME.FLOATING_MENU },
    { label: "BOOT", value: EDITOR_Z_INDEX.CHROME.BOOT_OVERLAY },
  ],
  popup: [
    { label: "ROOT", value: EDITOR_Z_INDEX.POPUP.PORTAL_ROOT },
    { label: "POPOVER", value: EDITOR_Z_INDEX.POPUP.POPOVER, annotated: "Island interior value" },
    { label: "TOOLTIP", value: EDITOR_Z_INDEX.POPUP.TOOLTIP, annotated: "Island interior value" },
  ],
  fullscreen: [
    { label: "OVERLAY", value: EDITOR_Z_INDEX.FULLSCREEN.OVERLAY },
  ],
  modal: [
    { label: "ROOT", value: EDITOR_Z_INDEX.MODAL.PORTAL_ROOT },
    { label: "ONBOARDING", value: EDITOR_Z_INDEX.MODAL.ONBOARDING, annotated: "Island interior value" },
    { label: "DIALOG", value: EDITOR_Z_INDEX.MODAL.DIALOG, annotated: "Island interior value" },
    { label: "POPOVER", value: EDITOR_Z_INDEX.MODAL.POPOVER, annotated: "Island interior value (forModal)" },
    { label: "TOOLTIP", value: EDITOR_Z_INDEX.MODAL.TOOLTIP, annotated: "Island interior value (forModal)" },
    { label: "PROMPT", value: EDITOR_Z_INDEX.MODAL.PROMPT },
    { label: "NOTIFICATION", value: EDITOR_Z_INDEX.MODAL.NOTIFICATION },
  ],
  window: [
    { label: "ROOT", value: EDITOR_Z_INDEX.WINDOW.PORTAL_ROOT },
    { label: "CONTEXT MENU", value: EDITOR_Z_INDEX.WINDOW.CONTEXT_MENU, annotated: "Island interior value" },
    { label: "BRANCH FLY", value: EDITOR_Z_INDEX.WINDOW.BRANCH_FLY },
  ],
  top: [
    { label: "CAPTURE", value: EDITOR_Z_INDEX.TOP.FULLSCREEN_CAPTURE },
  ],
};

type ViewMode = "2d" | "3d" | "audit";

const VIEW_MODES: Array<{ id: ViewMode; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: "2d", label: "2D", icon: Grid2x2 },
  { id: "3d", label: "Segments", icon: Move3d },
  { id: "audit", label: "Z Audit", icon: ScanSearch },
];

/** Shared highlight style for active 2D blueprint blocks. */
const BLOCK_ACTIVE = "bg-indigo-500/20 text-indigo-600 border-indigo-500/40 shadow-sm";
const BLOCK_IDLE = "bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-muted)] hover:border-indigo-500/40";
const CORNER_ACTIVE = "bg-indigo-500 border-indigo-500 text-white shadow";
const CORNER_IDLE = "bg-[var(--bg-panel)]/90 border-[var(--border-subtle)] text-[var(--text-main)] hover:border-indigo-500";

/**
 * LayoutInfoComponent (subscriber): owns the store-facing hooks and hands the
 * presenter only stable, memoized values. `useLayoutInfo` subscribes to the
 * whole editor state, so without this split every edit (a brush stroke, a
 * drag) would re-render the full 3D stack while the panel is open.
 */
export function LayoutInfoComponent() {
  const info = useLayoutInfo();
  const audit = useRuntimeZAudit();

  // toggleCmd identity is not guaranteed stable across renders; route close
  // through a ref so onClose stays referentially constant for React.memo.
  const toggleCmdRef = useRef(info.toggleCmd);
  useEffect(() => {
    toggleCmdRef.current = info.toggleCmd;
  }, [info.toggleCmd]);
  const onClose = useCallback(() => toggleCmdRef.current?.execute(), []);

  if (!info.isEnabled) return null;

  return (
    <LayoutInfoPanel
      layout={info.layout}
      viewportDim={info.viewportDim}
      slotsAnalysis={info.slotsAnalysis}
      slotGroups={info.slotGroups}
      segmentStack={info.segmentStack}
      slotSegmentMap={info.slotSegmentMap}
      activeGroupId={info.activeGroupId}
      activeSlotTab={info.activeSlotTab}
      focusedSegment={info.focusedSegment}
      selectSlot={info.selectSlot}
      focusSegment={info.focusSegment}
      auditResult={audit.result}
      auditScanning={audit.scanning}
      onAuditScan={audit.scan}
      onClose={onClose}
    />
  );
}

type LayoutInfoState = ReturnType<typeof useLayoutInfo>;

interface LayoutInfoPanelProps {
  layout: LayoutInfoState["layout"];
  viewportDim: LayoutInfoState["viewportDim"];
  slotsAnalysis: LayoutInfoState["slotsAnalysis"];
  slotGroups: LayoutInfoState["slotGroups"];
  segmentStack: LayoutInfoState["segmentStack"];
  slotSegmentMap: LayoutInfoState["slotSegmentMap"];
  activeGroupId: string;
  activeSlotTab: LayoutInfoState["activeSlotTab"];
  focusedSegment: string | null;
  selectSlot: LayoutInfoState["selectSlot"];
  focusSegment: LayoutInfoState["focusSegment"];
  auditResult: ReturnType<typeof useRuntimeZAudit>["result"];
  auditScanning: boolean;
  onAuditScan: () => void;
  onClose: () => void;
}

/**
 * LayoutInfoPanel (presenter): the Blueprint Inspector — 2D layout blueprint,
 * 3D segment-matrix stack, runtime z-index audit and the slots registry
 * explorer. Memoized: it re-renders only when the panel's own inputs change.
 */
const LayoutInfoPanel = React.memo(function LayoutInfoPanel({
  layout,
  viewportDim,
  slotsAnalysis,
  slotGroups,
  segmentStack,
  slotSegmentMap,
  activeGroupId,
  activeSlotTab,
  focusedSegment,
  selectSlot,
  focusSegment,
  auditResult,
  auditScanning,
  onAuditScan,
  onClose,
}: LayoutInfoPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("3d");

  const activeGroup = slotGroups.find(g => g.id === activeGroupId) ?? slotGroups[0];

  const topBlock = Object.values(layout.registeredSlots).find(s => s.role === "TOP_PUSH");
  const bottomBlock = Object.values(layout.registeredSlots).find(s => s.role === "BOTTOM_PUSH");
  const leftBlock = Object.values(layout.registeredSlots).find(s => s.role === "LEFT_PUSH");
  const rightBlock = Object.values(layout.registeredSlots).find(s => s.role === "RIGHT_PUSH");

  const countOf = (slot: string) => slotsAnalysis.find(s => s.name === slot)?.items.length ?? 0;
  const isChromeFocused = focusedSegment === "chrome";
  const isStageFocused = focusedSegment === "stage";

  const currentSlotAnalysis: SlotAnalysis =
    slotsAnalysis.find(s => s.name === activeSlotTab) ?? { name: activeSlotTab as EditorSlot, items: [] };
  const activeBinding = activeSlotTab ? slotSegmentMap[activeSlotTab] : undefined;
  const activeBindingSegment = activeBinding ? segmentStack.find(s => s.id === activeBinding.segmentId) : undefined;

  const cornerButton = (slot: EditorSlot, positionClass: string, widthClass: string) => (
    <button
      onClick={e => {
        e.stopPropagation();
        selectSlot(slot);
      }}
      className={`absolute ${positionClass} ${widthClass} h-6 rounded border text-[7px] font-black uppercase flex items-center justify-center transition-all outline-none cursor-pointer ${
        activeSlotTab === slot || isChromeFocused ? CORNER_ACTIVE : CORNER_IDLE
      }`}
    >
      {slot}({countOf(slot)})
    </button>
  );

  return (
    <PopupPanel
      isVisible={true}
      onClose={onClose}
      title="Blueprint Inspector"
      subTitle="Workspace Layout & Z-Index Matrix"
      icon={<Target size={14} />}
      status={layout.status}
      mode="responsive"
      size="sm"
      position="BR"
      closeOnOutsideClick={false}
    >
      {isExpanded => (
        <>
          {isExpanded ? (
            <div className="flex-1 min-h-0 flex gap-6 animate-in fade-in zoom-in-99 duration-300 p-5">
              {/* LEFT: views */}
              <div className="w-[560px] flex flex-col gap-3.5 border-r border-[var(--border-subtle)] pr-6 flex-shrink-0">
                <div className="flex items-center justify-between text-[var(--text-main)] flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <Box size={12} className="text-[var(--text-muted)]" />
                    <span className="text-[11px] font-black uppercase tracking-tight">
                      {viewMode === "audit" ? "Runtime Z Audit" : "Interactive Visual Blueprint"}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
                    {VIEW_MODES.map(mode => (
                      <button
                        key={mode.id}
                        onClick={() => setViewMode(mode.id)}
                        className={`px-2 py-0.5 rounded text-[8px] font-black uppercase transition-all outline-none cursor-pointer flex items-center gap-1 ${
                          viewMode === mode.id
                            ? "bg-indigo-500 text-white shadow-sm"
                            : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                        }`}
                      >
                        <mode.icon size={9} />
                        {mode.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="w-full flex-1 min-h-0 border border-[var(--border-subtle)] rounded-2xl bg-[var(--bg-stage)] p-3 flex flex-col overflow-hidden relative shadow-inner">
                  {viewMode === "2d" && (
                    <div className="w-full h-full flex flex-col gap-1.5">
                      {/* OptionBar (TOP_PUSH) */}
                      <button
                        onClick={() => selectSlot("OPTION_BAR")}
                        className={`h-7 rounded-lg transition-all border flex items-center justify-center font-mono text-[8px] font-bold tracking-tight uppercase outline-none cursor-pointer ${
                          activeSlotTab === "OPTION_BAR" || isChromeFocused ? BLOCK_ACTIVE : BLOCK_IDLE
                        }`}
                      >
                        OptionBar (Height: {topBlock?.height || 48}px)
                      </button>

                      <div className="flex-grow flex gap-1.5 min-h-0">
                        {/* Left drawer (LEFT_PUSH) */}
                        <button
                          onClick={() => selectSlot("SIDE_BAR")}
                          className={`w-9 rounded-lg transition-all border flex flex-col items-center justify-center font-mono text-[7px] font-bold uppercase leading-none overflow-hidden outline-none cursor-pointer ${
                            activeSlotTab === "SIDE_BAR" || isChromeFocused ? BLOCK_ACTIVE : BLOCK_IDLE
                          }`}
                        >
                          <span style={{ writingMode: "vertical-lr", transform: "rotate(180deg)" }} className="whitespace-nowrap">
                            LeftBar ({leftBlock?.width || 52}px)
                          </span>
                        </button>

                        {/* Canvas area with corner slots */}
                        <div
                          className={`flex-grow rounded-lg transition-all border flex flex-col items-center justify-center font-mono text-[8px] gap-0.5 relative p-4 ${
                            isStageFocused
                              ? "bg-emerald-500/[0.08] text-emerald-600 border-emerald-500/40"
                              : "bg-indigo-500/[0.03] border-indigo-500/10 text-indigo-600"
                          }`}
                        >
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              selectSlot("TOOL_MENU");
                            }}
                            className={`absolute top-2.5 left-2.5 w-16 h-6 rounded border text-[7.5px] font-black uppercase flex items-center justify-center gap-1 transition-all outline-none cursor-pointer ${
                              activeSlotTab === "TOOL_MENU"
                                ? "bg-amber-500 border-amber-500 text-white shadow"
                                : "bg-amber-500/10 border-amber-500/35 text-amber-600 hover:bg-amber-500/25"
                            }`}
                            title="Floating Tool Menu"
                          >
                            <Sparkles size={9} />
                            Float Menu
                          </button>
                          {cornerButton("TL", "top-2.5 left-20", "w-8")}
                          {cornerButton("TR", "top-2.5 right-2.5", "w-8")}
                          {cornerButton("BL", "bottom-2.5 left-2.5", "w-8")}
                          {cornerButton("BR", "bottom-2.5 right-2.5", "w-8")}
                          {cornerButton("DOCK", "bottom-2.5 left-[50%] -translate-x-[50%]", "w-14")}

                          <span className="font-black text-[9px] uppercase tracking-wider mb-0.5 mt-[-6px]">
                            Canvas SafeRect
                          </span>
                          <span className="font-bold tabular-nums">
                            w: {layout.safeRect.w} × h: {layout.safeRect.h} px
                          </span>
                          <span className="text-[6.5px] opacity-60 leading-none">
                            Offset x: {layout.safeRect.x}, y: {layout.safeRect.y}
                          </span>
                        </div>

                        {/* Right drawer (RIGHT_PUSH) */}
                        <button
                          onClick={() => selectSlot("SIDE_BAR")}
                          className={`w-9 rounded-lg transition-all border flex flex-col items-center justify-center font-mono text-[7px] font-bold uppercase leading-none overflow-hidden outline-none cursor-pointer ${
                            activeSlotTab === "SIDE_BAR" || isChromeFocused ? BLOCK_ACTIVE : BLOCK_IDLE
                          }`}
                        >
                          <span style={{ writingMode: "vertical-rl" }} className="whitespace-nowrap">
                            RightBar ({rightBlock?.width || 320}px)
                          </span>
                        </button>
                      </div>

                      {bottomBlock ? (
                        <button
                          onClick={() => selectSlot("DOCK")}
                          className={`h-6 rounded-lg transition-all border flex items-center justify-center font-mono text-[7.5px] font-bold uppercase outline-none cursor-pointer ${
                            activeSlotTab === "DOCK" || isChromeFocused ? BLOCK_ACTIVE : BLOCK_IDLE
                          }`}
                        >
                          Dock (Height: {bottomBlock.height}px)
                        </button>
                      ) : (
                        <div className="h-1 bg-transparent" />
                      )}
                    </div>
                  )}

                  {viewMode === "3d" && (
                    <SegmentStack3D
                      segmentStack={segmentStack}
                      seatMap={SEAT_MAP}
                      focusedSegment={focusedSegment}
                      onFocusSegment={focusSegment}
                    />
                  )}

                  {viewMode === "audit" && (
                    <RuntimeZAudit
                      segmentStack={segmentStack}
                      result={auditResult}
                      scanning={auditScanning}
                      onScan={onAuditScan}
                    />
                  )}
                </div>

                {/* Layout sizing */}
                <div className="grid grid-cols-2 gap-2.5 text-[9px] font-mono flex-shrink-0">
                  <div className="p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                    <div className="text-[7.5px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none mb-1">
                      Browser Viewport
                    </div>
                    <div className="font-bold text-[var(--text-main)] tabular-nums">W: {viewportDim.w} px</div>
                    <div className="font-bold text-[var(--text-main)] tabular-nums">H: {viewportDim.h} px</div>
                  </div>
                  <div className="p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex flex-col gap-0.5">
                    <div className="text-[7.5px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none mb-1">
                      SafeRect Boundaries
                    </div>
                    <div className="font-bold text-indigo-600 tabular-nums">
                      X: {layout.safeRect.x} px | Y: {layout.safeRect.y} px
                    </div>
                    <div className="font-bold text-indigo-600 tabular-nums">
                      W: {layout.safeRect.w} px | H: {layout.safeRect.h} px
                    </div>
                  </div>
                </div>
              </div>

              {/* RIGHT: slots registry explorer */}
              <div className="flex-grow flex flex-col gap-3.5 min-w-0">
                <div className="flex items-center justify-between text-[var(--text-main)] flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <List size={12} className="text-[var(--text-muted)]" />
                    <span className="text-[11px] font-black uppercase tracking-tight">Slots Registry Explorer</span>
                  </div>
                  <span className="text-[8.5px] font-mono text-[var(--text-muted)] bg-[var(--bg-stage)] px-2 py-0.5 rounded">
                    Total mounts: {slotsAnalysis.reduce((sum, s) => sum + s.items.length, 0)}
                  </span>
                </div>

                {/* Tier 1: groups */}
                <div
                  className="grid gap-1 p-0.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex-shrink-0"
                  style={{ gridTemplateColumns: `repeat(${Math.max(1, slotGroups.length)}, minmax(0, 1fr))` }}
                >
                  {slotGroups.map(group => {
                    const isActiveGroup = activeGroup?.id === group.id;
                    const totalGroupMounts = group.slots.reduce((sum, sn) => sum + countOf(sn), 0);
                    return (
                      <button
                        key={group.id}
                        onClick={() => selectSlot(group.slots[0])}
                        className={`flex flex-col items-center justify-center py-1.5 px-1.5 rounded-lg transition-all text-center gap-1 outline-none cursor-pointer ${
                          isActiveGroup
                            ? "bg-[var(--bg-panel)] shadow-md text-[var(--text-main)] scale-[1.02] border border-indigo-500/30 ring-1 ring-indigo-500/10"
                            : "text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-panel)] border border-transparent"
                        }`}
                      >
                        <group.icon size={11} className={isActiveGroup ? "text-indigo-500" : "text-[var(--text-muted)]"} />
                        <span className="text-[7.5px] font-black uppercase tracking-tighter truncate max-w-full">{group.name}</span>
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

                {/* Tier 2: slots */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide border-b border-[var(--border-subtle)] flex-shrink-0 font-mono text-[9px] -mx-1 px-1">
                  {(activeGroup?.slots ?? []).map(slotName => {
                    const isActiveSlot = activeSlotTab === slotName;
                    const count = countOf(slotName);
                    return (
                      <button
                        key={slotName}
                        onClick={() => selectSlot(slotName)}
                        className={`flex items-center gap-1.5 py-1 px-2.5 rounded-lg border font-bold whitespace-nowrap transition-all flex-shrink-0 outline-none cursor-pointer ${
                          isActiveSlot
                            ? "bg-indigo-500 border-indigo-500 text-white shadow-md"
                            : "bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-main)] hover:border-indigo-500/40"
                        }`}
                      >
                        <span>{slotName}</span>
                        <span
                          className={`text-[7.5px] font-black px-1 py-0.5 rounded-full ${
                            isActiveSlot
                              ? "bg-white/20 text-white"
                              : count > 0
                                ? "bg-indigo-500/10 text-indigo-600"
                                : "bg-[var(--bg-stage)] text-[var(--text-muted)]"
                          }`}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Matrix seat of the active slot */}
                {activeBinding && activeBindingSegment && (
                  <div
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xl text-[8px] font-black uppercase tracking-tight flex-shrink-0 ${
                      (SEGMENT_COLORS[activeBindingSegment.color] ?? SEGMENT_COLORS.emerald).chip
                    }`}
                    title={activeBindingSegment.note}
                  >
                    <span className="font-mono">{activeBindingSegment.level}</span>
                    <span>{activeBindingSegment.name}</span>
                    <span className="opacity-60">·</span>
                    <span className="normal-case font-bold">{activeBinding.seatLabel}</span>
                  </div>
                )}

                {/* Contributions */}
                <div className="flex-1 overflow-y-auto space-y-2.5 pr-1.5 scrollbar-hide font-mono text-[9.5px]">
                  {currentSlotAnalysis.items.length > 0 ? (
                    currentSlotAnalysis.items.map((item: ContributionItem, idx: number) => (
                      <div
                        key={`${item.pluginId}-${item.type}-${item.order}-${idx}`}
                        className="p-3 rounded-2xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex items-center justify-between hover:border-[var(--border-light)] transition-all"
                      >
                        <div className="flex flex-col gap-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                            <span className="font-black text-[10px] text-[var(--text-main)] truncate">{item.pluginId}</span>
                          </div>
                          <span className="text-[8px] text-[var(--text-muted)] uppercase font-black leading-none pl-3.5">
                            Mount: {item.type}
                            {item.showPolicy !== "always-show" ? ` | policy: ${item.showPolicy}` : ""}
                          </span>
                        </div>
                        <span className="text-[8.5px] font-black text-indigo-600 uppercase tracking-wider bg-indigo-500/10 px-2 py-1 rounded-lg">
                          Order: {item.order}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="flex-grow flex flex-col items-center justify-center p-8 rounded-2xl bg-[var(--bg-stage)] border border-dashed border-[var(--border-subtle)] text-[var(--text-muted)] text-center uppercase tracking-wide py-12 gap-2">
                      <AlertCircle size={16} className="opacity-40" />
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[9px] font-black tracking-wider">No Mounts In Slot</span>
                        <span className="text-[7.5px] opacity-75 font-bold normal-case leading-relaxed">
                          No plugins or contributions have registered to mount in the &quot;{activeSlotTab}&quot; slot region.
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* COMPACT VIEW */
            <div className="flex-grow flex flex-col gap-3.5 min-h-0 animate-in fade-in zoom-in-99 duration-300 p-5">
              <div className="space-y-1.5 flex-shrink-0">
                <div className="flex items-center gap-2 text-[var(--text-main)]">
                  <Box size={11} className="text-[var(--text-muted)]" />
                  <span className="text-[10px] font-black uppercase tracking-tight">Segment Matrix</span>
                </div>
                {/* Compact segment ladder: S6 on top, each row base + name */}
                <div className="w-full rounded-2xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] p-2 flex flex-col gap-0.5 shadow-inner">
                  {[...segmentStack].reverse().map(segment => {
                    const colors = SEGMENT_COLORS[segment.color] ?? SEGMENT_COLORS.emerald;
                    return (
                      <div
                        key={segment.id}
                        title={segment.note}
                        className={`flex items-center justify-between px-2 py-0.5 rounded-md text-[7.5px] font-black uppercase ${colors.chip}`}
                      >
                        <span className="font-mono">{segment.level}</span>
                        <span className="flex-1 pl-2 truncate">{segment.name}</span>
                        <span className="tabular-nums opacity-70">{segment.base}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[9px] font-mono flex-shrink-0">
                <div className="p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
                  <div className="text-[7.5px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none mb-1">Viewport Dim</div>
                  <div className="font-bold text-[var(--text-main)] tabular-nums">{viewportDim.w}×{viewportDim.h} px</div>
                </div>
                <div className="p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
                  <div className="text-[7.5px] font-black text-[var(--text-muted)] uppercase tracking-widest leading-none mb-1">SafeRect Offset</div>
                  <div className="font-bold text-indigo-600 tabular-nums">X:{layout.safeRect.x} Y:{layout.safeRect.y} px</div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 scrollbar-hide border-t border-[var(--border-subtle)] pt-2.5 select-none font-mono text-[9px]">
                <div className="flex items-center justify-between text-[var(--text-main)] pb-1">
                  <div className="flex items-center gap-1.5">
                    <List size={11} className="text-[var(--text-muted)]" />
                    <span className="text-[9px] font-black uppercase tracking-tight">Slot Brief Directory</span>
                  </div>
                  <span className="text-[8px] font-black text-indigo-500/40 uppercase">Expand for Details</span>
                </div>
                {slotsAnalysis
                  .filter(s => s.items.length > 0)
                  .map(slot => (
                    <button
                      key={slot.name}
                      onClick={() => selectSlot(slot.name)}
                      className="w-full p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] flex items-center justify-between hover:border-indigo-500/40 outline-none cursor-pointer transition-all"
                    >
                      <span className="font-bold text-[var(--text-main)] uppercase tracking-tight">{slot.name}</span>
                      <span className="text-[8px] font-black text-indigo-500 uppercase tracking-wider bg-indigo-500/10 px-2 py-0.5 rounded-md font-mono">
                        {slot.items.length} Mounts
                      </span>
                    </button>
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
    <FancyButton
      title="Editor Layout Blueprint"
      active={isEnabled}
      onClick={() => toggleCmd?.execute()}
      iconOnly
      shape="rect"
    >
      <LayoutDashboard size={14} />
    </FancyButton>
  );
}
