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

import React, { useState, useRef, useEffect } from "react";
import {
  Split,
  ChevronDown,
  Maximize,
  Check,
  X,
  Hand,
  Move,
  ImageUpscale,
  Scissors,
  Copy as CopyIcon,
  ClipboardPaste,
  ScissorsLineDashed,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  useEditorState,
  usePluginSignals,
} from "@opengpex/editor/core/context";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import ComboInput from "@opengpex/editor/widgets/ComboInput";
import { useClipOptionsCommands } from "./hooks";
import { CROP_TOOL_STRATEGIES, type CropToolStrategy } from "./protocols";

const ASPECT_RATIOS = [
  { label: "FREE", value: undefined },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "2:3", value: 2 / 3 },
  { label: "3:2", value: 3 / 2 },
];

/**
 * ClipOptionsMain: Integrated persistent component for clipping and canvas operations
 * Includes clip mode switching, ratio adjustment, and WebP export functions
 */
export const ClipOptionsMain = React.memo(function ClipOptionsMain() {
  const { state, activeFrame } = useEditorState();
  const {
    toggleModeCmd,
    reCanvasToggleCmd,
    reCanvasApplyCmd,
    setAspectCmd,
    branchCreateCmd,
    updateClipBox,
    closeReCanvas,
    cropToolSetCmd,
    applyMaskCmd,
    cropTool,
    isIrregularTool,
    hasIrregularBox,
  } = useClipOptionsCommands();

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isShapeDropdownOpen, setIsShapeDropdownOpen] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shapeHoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleShapeMouseEnter = () => {
    if (!activeFrame || isPanMode) return;
    if (shapeHoverTimeoutRef.current)
      clearTimeout(shapeHoverTimeoutRef.current);
    setIsShapeDropdownOpen(true);
  };

  const handleShapeMouseLeave = () => {
    shapeHoverTimeoutRef.current = setTimeout(() => {
      setIsShapeDropdownOpen(false);
    }, 150);
  };

  const handleMouseEnter = () => {
    if (!activeFrame || isPanMode) return;
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsDropdownOpen(true);
  };

  const handleMouseLeave = () => {
    hoverTimeoutRef.current = setTimeout(() => {
      setIsDropdownOpen(false);
    }, 150);
  };

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      if (shapeHoverTimeoutRef.current)
        clearTimeout(shapeHoverTimeoutRef.current);
    };
  }, []);

  const { reCanvasActiveSignal } = usePluginSignals();

  if (!activeFrame) return null;

  const isReCanvas = !!reCanvasActiveSignal.value;
  const cropShape = isReCanvas
    ? activeFrame.canvasCropBox
    : activeFrame.imageCropBox;
  const cropRect = cropShape.rect;
  const activeAspect = isReCanvas
    ? activeFrame.canvasAspect
    : activeFrame.imageAspect;

  const isClipActive = state.interaction.interactionMode === "clip";
  const isPanMode = !isClipActive;
  const currentRatio =
    ASPECT_RATIOS.find((r) => r.value === activeAspect) || ASPECT_RATIOS[0];

  const disabledClasses =
    "opacity-40 cursor-not-allowed grayscale-[0.5] pointer-events-none";

  // ─── Crop tool → main-button visual mapping (§3.2.2 / Pre-PR-6-2) ─────────
  // The per-tool icon + accent palette now lives entirely in
  // `CROP_TOOL_STRATEGIES` (single source of truth in `protocols.ts`). The
  // local `TOOL_VISUAL` table that used to mirror those rows was removed —
  // adding a new tool no longer requires touching this file.
  const activeStrategy = CROP_TOOL_STRATEGIES[cropTool] ?? CROP_TOOL_STRATEGIES.rect;
  const ToolIcon = activeStrategy.icon;
  // Map abstract `accent` palette to Tailwind utility strings. We deliberately
  // keep this thin map at the call-site (rather than embedding Tailwind class
  // strings inside the strategy table) so `protocols.ts` stays free of
  // styling concerns and reusable across L3–L6 consumers.
  const ACCENT_CLASSES = {
    amber:  { textClass: "text-amber-600 dark:text-amber-500", borderOpenClass: "border-amber-500/50",  activeBg: "bg-amber-500/10 text-amber-600 dark:text-amber-400"  },
    purple: { textClass: "text-purple-500",                    borderOpenClass: "border-purple-500/50", activeBg: "bg-purple-500/10 text-purple-600 dark:text-purple-400" },
  } as const;
  const toolVisual = ACCENT_CLASSES[activeStrategy.accent];

  return (
    <div className="flex items-center gap-1 -mr-1 animate-in fade-in slide-in-from-left-2 duration-300">
      {/* 1. Header Section */}
      <div className="flex items-center">
        <div className="flex items-center gap-1">
          {isPanMode ? (
            <Move size={12} className="text-[var(--text-muted)]" />
          ) : (
            <Maximize size={12} className="text-[var(--text-muted)]" />
          )}
          <div className="w-10 flex justify-center hidden lg:flex">
            <span className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">
              {isPanMode ? "NAVI" : "CLIP"}
            </span>
          </div>
        </div>
      </div>

      {/* 2. Aspect Ratio 2-Segment Split Button */}
      <div className="relative flex items-center">
        <div
          className={`relative flex items-center h-7 rounded-xl transition-all border shadow-sm
          ${
            (isDropdownOpen || isShapeDropdownOpen) && !isPanMode
              ? `bg-[var(--bg-panel)] ${toolVisual.borderOpenClass} shadow-lg`
              : "bg-[var(--bg-panel)] border-[var(--border-subtle)] hover:border-[var(--border-light)]"
          }
        `}
        >
          {/* Segment 1: Mode Toggle & Tool Selector — icon/colour follows cropTool (§3.2.2) */}
          <div className="relative h-full">
            <button
              onClick={() => toggleModeCmd?.execute()}
              onMouseEnter={handleShapeMouseEnter}
              onMouseLeave={handleShapeMouseLeave}
              disabled={isReCanvas}
              className={`flex items-center justify-center w-8 h-7 rounded-l-xl transition-colors group outline-none select-none
                ${isReCanvas ? disabledClasses : "hover:bg-[var(--bg-stage)]"}
              `}
              title={`Toggle Mode (${toggleModeCmd?.shortcutLabel || ""})`}
            >
              {isPanMode ? (
                <Hand size={13} className="text-[var(--text-muted)]" />
              ) : (
                <ToolIcon size={13} className={toolVisual.textClass} />
              )}
            </button>

            <AnimatePresence>
              {isShapeDropdownOpen && !isPanMode && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 5 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 5 }}
                  onMouseEnter={handleShapeMouseEnter}
                  onMouseLeave={handleShapeMouseLeave}
                  className="absolute top-full left-0 mt-1.5 w-44 bg-[var(--bg-panel)] backdrop-blur-xl border border-[var(--border-subtle)] rounded-xl shadow-2xl overflow-hidden z-50 p-1 ring-1 ring-black/5"
                >
                  <div className="flex flex-col gap-0.5">
                    {/*
                     * Pre-PR-6-2: dropdown items are now generated by iterating
                     * `Object.values(CROP_TOOL_STRATEGIES)`. A divider is
                     * inserted automatically between consecutive items whose
                     * `family` differs (currently regular → irregular). Adding
                     * a new tool to the strategy table makes it appear here
                     * without touching this file.
                     */}
                    {(Object.values(CROP_TOOL_STRATEGIES) as CropToolStrategy[]).map((s, idx, arr) => {
                      const Icon = s.icon;
                      const active = cropTool === s.id;
                      const accent = ACCENT_CLASSES[s.accent];
                      // Insert a separator immediately before the first item
                      // of a new family group (so we don't get a leading or
                      // trailing divider).
                      const showDivider = idx > 0 && arr[idx - 1].family !== s.family;
                      return (
                        <React.Fragment key={s.id}>
                          {showDivider && <div className="my-1 h-px bg-[var(--border-subtle)]" />}
                          <button
                            onClick={() => {
                              cropToolSetCmd?.execute({ tool: s.id });
                              setIsShapeDropdownOpen(false);
                            }}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors text-left
                              ${
                                active
                                  ? accent.activeBg
                                  : "text-[var(--text-muted)] hover:bg-[var(--bg-stage)] hover:text-[var(--text-main)]"
                              }
                            `}
                          >
                            <Icon size={12} className="shrink-0" />
                            <span className="text-[10px] font-bold uppercase tracking-wide whitespace-nowrap">
                              {s.label}
                            </span>
                            {active && <Check size={10} className="ml-auto" />}
                          </button>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="w-[1px] h-3 bg-zinc-300 dark:bg-white/20" />

          {/* Segment 2: Aspect Ratio Selector — disabled on irregular tools (§3.2.4) */}
          <button
            onMouseEnter={isIrregularTool ? undefined : handleMouseEnter}
            onMouseLeave={isIrregularTool ? undefined : handleMouseLeave}
            className="flex items-center h-full outline-none select-none"
            disabled={isIrregularTool}
            title={isIrregularTool ? "Aspect ratio is N/A for lasso / wand selection" : undefined}
          >
            <div
              className={`flex items-center gap-1.5 px-2 h-full rounded-r-xl transition-colors outline-none select-none
              ${
                isPanMode || isIrregularTool
                  ? disabledClasses
                  : "hover:bg-[var(--bg-stage)]"
              }
            `}
            >
              <span className="text-[10px] font-black text-[var(--text-main)] min-w-[32px] text-center">
                {currentRatio.label}
              </span>
              <ChevronDown
                size={10}
                className={`text-[var(--text-muted)] transition-transform duration-300 ${isDropdownOpen ? "rotate-180" : ""}`}
              />
            </div>
          </button>
        </div>

        {/* Floating Dropdown */}
        <AnimatePresence>
          {isDropdownOpen && !isPanMode && !isIrregularTool && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 5 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 5 }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
              className="absolute top-full left-0 mt-1.5 w-48 bg-[var(--bg-panel)] backdrop-blur-xl border border-[var(--border-subtle)] rounded-xl shadow-2xl overflow-hidden z-50 p-1.5 ring-1 ring-black/5"
            >
              <AspectGrid
                activeAspect={activeAspect}
                onSelect={(val) => {
                  setAspectCmd?.execute({ aspect: val });
                  setIsDropdownOpen(false);
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* <div className="w-[1px] h-3 bg-zinc-300 dark:bg-white/20 mx-1" /> */}

      {/* 3. Actions Group */}
      <div className="flex items-center gap-0.5 ml-1.5">
        <FunctionButton
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            branchCreateCmd?.execute({ rect });
          }}
          disabled={isPanMode || isReCanvas}
          title={`Create Branch (${branchCreateCmd?.shortcutLabel || ""})`}
          variant="ghost"
          tooltipPosition="bottom"
          className="w-6 h-6"
        >
          <Split size={13} className="text-emerald-500" />
        </FunctionButton>

        {/*
         * Apply Mask — purple, lasso/wand-only (§3.2.5).
         * Renders only when:
         *   - the active tool is irregular (lasso/wand), AND
         *   - the user has actually committed a polygon (irregularCropBox != null), AND
         *   - we are in clip mode and not Re-Canvas.
         * The space at the right of `branchCreateCmd` is reserved for the future
         * "antiAliased toggle" sibling per §5.2 #4 — do NOT wrap into a PluginSlot.
         */}
        {isIrregularTool && hasIrregularBox && !isPanMode && !isReCanvas && (
          <FunctionButton
            onClick={() => applyMaskCmd?.execute({})}
            title="Apply Selection as Mask"
            variant="ghost"
            tooltipPosition="bottom"
            className="w-6 h-6"
          >
            <ScissorsLineDashed size={13} className="text-purple-500" />
          </FunctionButton>
        )}

        <div className="relative">
          <FunctionButton
            disabled={isPanMode}
            onClick={() => reCanvasToggleCmd?.execute()}
            title="Toggle Canvas Resize Mode"
            variant="ghost"
            tooltipPosition="bottom"
            className="w-6 h-6"
          >
            <ImageUpscale
              size={13}
              className={
                isReCanvas ? "animate-pulse text-white" : "text-rose-500"
              }
            />
          </FunctionButton>

          <AnimatePresence>
            {isReCanvas && !isPanMode && (
              <motion.div
                initial={{ opacity: 0, y: 5, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 5, scale: 0.98 }}
                className="absolute top-full mt-2 left-0 flex flex-col gap-2.5 bg-[var(--bg-panel)] backdrop-blur-xl border border-[var(--border-light)] rounded-xl shadow-2xl p-2.5 z-[200] ring-1 ring-black/5"
              >
                <div className="flex justify-between items-center px-0.5">
                  <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-wider">
                    Re-Size Canvas
                  </span>
                  <button
                    onClick={closeReCanvas}
                    className="flex items-center justify-center w-5 h-5 text-[var(--text-muted)] hover:text-rose-500 hover:bg-[var(--bg-stage)] rounded-md transition-colors"
                  >
                    <X size={12} />
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <ComboInput
                    label="W"
                    value={Math.round(cropRect.w)}
                    type="number"
                    className="w-[64px]"
                    onChange={(val) => {
                      const parsedVal = Math.max(1, Number(val));
                      const patch: { w?: number; h?: number } = {
                        w: parsedVal,
                      };
                      if (activeFrame.canvasAspect) {
                        patch.h = Math.round(
                          parsedVal / activeFrame.canvasAspect,
                        );
                      }
                      updateClipBox(patch);
                    }}
                  />
                  <span className="text-zinc-500 text-[10px]">×</span>
                  <ComboInput
                    label="H"
                    value={Math.round(cropRect.h)}
                    type="number"
                    className="w-[64px]"
                    onChange={(val) => {
                      const parsedVal = Math.max(1, Number(val));
                      const patch: { w?: number; h?: number } = {
                        h: parsedVal,
                      };
                      if (activeFrame.canvasAspect) {
                        patch.w = Math.round(
                          parsedVal * activeFrame.canvasAspect,
                        );
                      }
                      updateClipBox(patch);
                    }}
                  />
                </div>

                <div className="flex justify-end pt-1 mt-0.5">
                  <FunctionButton
                    onClick={() => reCanvasApplyCmd?.execute()}
                    variant="ghost"
                    className="h-6 w-auto px-2 text-[10px] !bg-rose-500 hover:!bg-rose-600 !text-white gap-1"
                  >
                    <Check size={11} strokeWidth={3} />
                    APPLY
                  </FunctionButton>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
});

/**
 * AspectGrid: Shared UI for aspect ratio selection
 */
function AspectGrid({
  activeAspect,
  onSelect,
}: {
  activeAspect: number | undefined;
  onSelect: (val: number | undefined) => void;
}) {
  const { activeFrame } = useEditorState();
  const { reCanvasActiveSignal } = usePluginSignals();
  const isReCanvas = !!reCanvasActiveSignal.value;
  const cropBox = isReCanvas
    ? activeFrame?.canvasCropBox
    : activeFrame?.imageCropBox;
  const isEllipse = cropBox?.type === "circle";
  const isDashed = isEllipse && cropBox?.antiAliased === false;

  return (
    <div className="grid grid-cols-2 gap-1 mb-1.5">
      {ASPECT_RATIOS.map((ratio) => (
        <button
          key={ratio.label}
          onClick={() => onSelect(ratio.value)}
          className={`flex flex-col items-center justify-center p-2 rounded-lg transition-all group/ratio
            ${
              activeAspect === ratio.value
                ? "bg-amber-500/10 border border-amber-500/30 shadow-[0_0_15px_rgba(245,158,11,0.1)]"
                : "hover:bg-[var(--bg-stage)] border border-transparent"
            }
          `}
        >
          <div className="relative mb-1">
            <div
              className={`border-2 mb-0.5 transition-all
              ${isDashed ? "border-dashed" : "border-solid"}
              ${
                activeAspect === ratio.value
                  ? "border-amber-500"
                  : "border-[var(--text-muted)] opacity-30 group-hover/ratio:opacity-100 group-hover/ratio:border-[var(--border-light)]"
              }
            `}
              style={{
                width: 14,
                height: Math.max(4, 14 / (ratio.value || 1)),
                borderRadius: isEllipse ? "50%" : "2px",
              }}
            ></div>
          </div>
          <span
            className={`text-[9px] font-black uppercase tracking-widest
            ${activeAspect === ratio.value ? "text-amber-600 dark:text-amber-400" : "text-[var(--text-muted)]"}
          `}
          >
            {ratio.label}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * ClipSelectionActions: Clipboard button group contributed to TOOL_BAR
 * Migrated from LayerPanel to ClipOptions to reinforce semantic consistency of selection operations.
 */
export const ClipSelectionActions = React.memo(function ClipSelectionActions() {
  const { state } = useEditorState();
  const { cutCmd, copyCmd, pasteCmd } = useClipOptionsCommands();
  return (
    <>
      <FunctionButton
        onClick={() => cutCmd.execute()}
        disabled={state.interaction.interactionMode !== "clip"}
        title={`${cutCmd.name} (${cutCmd.shortcutLabel})`}
        tooltipPosition="right"
        variant="ghost"
        className="w-6 h-6"
      >
        <Scissors size={13} />
      </FunctionButton>
      <FunctionButton
        onClick={() => copyCmd.execute()}
        disabled={state.interaction.interactionMode !== "clip"}
        title={`${copyCmd.name} (${copyCmd.shortcutLabel})`}
        tooltipPosition="right"
        variant="ghost"
        className="w-6 h-6"
      >
        <CopyIcon size={13} />
      </FunctionButton>
      <FunctionButton
        onClick={() => pasteCmd.execute(undefined)}
        disabled={false}
        title={`${pasteCmd.name} (${pasteCmd.shortcutLabel})`}
        tooltipPosition="right"
        variant="ghost"
        className="w-6 h-6"
      >
        <ClipboardPaste size={13} />
      </FunctionButton>
    </>
  );
});
