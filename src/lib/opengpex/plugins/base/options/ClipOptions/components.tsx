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
import {
  useEditorState,
  usePluginSignals,
} from "@opengpex/editor/core/context";

import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import ComboInput from "@opengpex/editor/widgets/ComboInput";
import Popover from "@opengpex/editor/widgets/Popover";
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
    exitClipModeCmd,
    reCanvasToggleCmd,
    reCanvasApplyCmd,
    setAspectCmd,
    branchCreateCmd,
    updateClipBox,
    closeReCanvas,
    cropToolSetCmd,
    applyMaskCmd,
    antiAliasToggleCmd,
    cropTool,
    isIrregularTool,
    hasIrregularBox,
    supportsAntiAlias,
    isAntiAliased,
  } = useClipOptionsCommands();


  const { reCanvasActiveSignal } = usePluginSignals();

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);



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
    };
  }, []);

  // ─── AA double-tap shortcut ─────────────────────────────────────────────
  // The "double-tap A → toggle Anti-Alias" gesture used to live here as a
  // local `keydown` listener (~60 LoC: tap-window timer, ref-based tap
  // count, autofocus/repeat/modifier/mode/tool guards). It now lives
  // declaratively on the command itself in `commands.ts`:
  //
  //   shortcut: { key: 'a', taps: 2 }
  //
  // The global `HotkeyManager` (workspace/components/HotkeyManager.tsx)
  // grew first-class multi-tap support (2026-06-23): a `taps: N` field on
  // `EditorShortcut` enforces an N-tap-within-`tapWindowMs` gesture,
  // rejects OS auto-repeat, and swallows intermediate keystrokes. The
  // runtime guards that used to live in this effect (clip mode active,
  // strategy supports AA, not in Re-Canvas) moved into the command's
  // `execute()` body so they're enforced equally for keyboard *and*
  // button activation paths.
  //
  // Result: one fewer local timer per ClipOptionsMain instance, the
  // shortcut shows up in any future "list all shortcuts" panel for free,
  // and the AA tooltip below is the only place this component still cares
  // about the `A A` binding (it reads the label off `shortcutLabel`).



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

  // ─── Dashed-stroke override for "AA OFF" tools ─────────────────────────
  // When the active tool supports AA *and* the user has turned AA off, the
  // tool's icon — both on the main toolbar button and inside the tool-strip
  // popover — should render with a dashed outline to mirror the on-canvas
  // box's dashed stroke (a visual reinforcement of "no anti-aliasing →
  // jagged / pixel-aligned edge"). Since the per-tool strategy table lists
  // which tools `supportsAntiAlias`, we don't need to special-case ellipse
  // here — any future AA-capable tool gets the same treatment for free.
  //
  // Implementation note: lucide-react icons accept arbitrary SVG attributes
  // via their `...rest` spread, so `strokeDasharray` flows through to the
  // underlying <svg> stroke. The dash length "3 3" is the same rhythm we
  // use for the marching-ants channels in the overlay, so the icon and
  // the canvas chrome are visually consistent.
  const dashedOverride = supportsAntiAlias && isAntiAliased === false;
  const dashedIconProps = dashedOverride
    ? ({ strokeDasharray: '3 3' } as React.SVGAttributes<SVGSVGElement>)
    : {};


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
            isDropdownOpen && !isPanMode
              ? `bg-[var(--bg-panel)] ${toolVisual.borderOpenClass} shadow-lg`
              : isClipActive
                ? `bg-[var(--bg-panel)] ${toolVisual.borderOpenClass} shadow-lg`
                : "bg-[var(--bg-panel)] border-[var(--border-subtle)] hover:border-[var(--border-light)]"
          }
        `}
        >
          {/*
           * Segment 1: Mode Toggle button — pure single-action button (mirrors
           * the AA button on its right). Clicking toggles pan ↔ clip via
           * `toggleModeCmd`. The crop-tool selector that used to live as a
           * hover dropdown on this button has been promoted to a Popover
           * anchored here whose lifecycle is bound to `isClipActive`
           * (Pre-PR-6-3: Clip-mode tool strip). Entering clip mode shows the
           * horizontal strip below the toolbar; exiting clip mode hides it.
           */}
          <Popover
            // ─── Tool-strip lifecycle (2026-06-23) ──────────────────────
            // Hidden during Re-Canvas because:
            //   1) Re-Canvas is rectangular-only by definition (lasso/wand
            //      would be force-coerced back to rect anyway), so the
            //      strip would be misleading;
            //   2) Re-Canvas owns its own visual focus (rose-tinted rect +
            //      W/H popover); showing two popovers at once doubles
            //      visual noise.
            // Re-Canvas is the orthogonal modal — it suspends clip-mode
            // chrome while it's open, without disrupting clip-mode data.
            isOpen={isClipActive && !isReCanvas}
            onClose={() => { /* lifecycle bound to clip mode — outside click & Esc must NOT dismiss */ }}
            position="bottom"
            align="center"
            offset={8}
            dismissOnOutsideClick={false}
            dismissOnEscape={false}
            display="inline-flex"
            // ─── Layering ─────────────────────────────────────────────
            // Lowered below the global default (9999) so siblings such as
            // the aspect-ratio dropdown (`z-50` on a portal-less motion.div)
            // and the Re-Canvas W/H popover (default 9999) naturally stack
            // *on top* of the tool strip. Otherwise the tool strip — which
            // is the longest-lived popover in clip mode — would occlude
            // those transient menus and the user would have to dismiss it
            // first to interact with them.
            zIndex={40}
            content={

              <div className="flex flex-row items-center gap-0.5 p-1">

                {/*
                 * Pre-PR-6-3: tool strip is generated by iterating
                 * `Object.values(CROP_TOOL_STRATEGIES)`. A vertical divider is
                 * inserted automatically between consecutive items whose
                 * `family` differs (currently regular → irregular). Adding a
                 * new tool to the strategy table makes it appear here without
                 * touching this file.
                 *
                 * Active-state palette for this *popover* is **brighter**
                 * than the call-site `ACCENT_CLASSES.activeBg` because the
                 * Popover bubble itself is rendered on a dark slate
                 * (`bg-zinc-800`) — the standard 10%-opacity wash that works
                 * fine on the light toolbar would dissolve into the dark
                 * background. We therefore look up a per-strategy palette
                 * keyed by `s.accent` and use heavier opacity (`/25`) +
                 * lighter foreground (`-300`) just for the popover items.
                 */}
                {(Object.values(CROP_TOOL_STRATEGIES) as CropToolStrategy[]).map((s, idx, arr) => {
                  const Icon = s.icon;
                  const active = cropTool === s.id;
                  // Popover-local active palette — works on both light
                  // (`--bg-panel: #ffffff`) and dark (`#2b2b2b`) bubble
                  // backgrounds. Tailwind JIT requires class strings to be
                  // statically discoverable, so we list the four full
                  // (purple/amber × light/dark) variants instead of
                  // computing them.
                  const popActiveBg = s.accent === 'purple'
                    ? 'bg-purple-500/15 text-purple-700 dark:bg-purple-400/25 dark:text-purple-200 ring-1 ring-purple-500/30 dark:ring-purple-300/30'
                    : 'bg-amber-500/15 text-amber-700 dark:bg-amber-400/25 dark:text-amber-200 ring-1 ring-amber-500/30 dark:ring-amber-300/30';
                  const showDivider = idx > 0 && arr[idx - 1].family !== s.family;
                  return (
                    <React.Fragment key={s.id}>
                      {showDivider && (
                        <div className="mx-1 w-px h-5 bg-[var(--border-subtle)]" />
                      )}
                      <button
                        onClick={() => cropToolSetCmd?.execute({ tool: s.id })}
                        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-colors whitespace-nowrap
                          ${
                            active
                              ? popActiveBg
                              : "text-[var(--text-muted)] hover:bg-[var(--bg-stage)] hover:text-[var(--text-main)]"
                          }
                        `}
                        title={s.label}
                      >
                        {/*
                         * Per-item dashed override: only the *currently
                         * active* AA-supporting tool follows the AA-OFF
                         * dashed-outline rule. Non-active items always
                         * render solid because their AA flag isn't being
                         * mutated by the AA toggle right now (the AA flag
                         * is per-active-shape, not per-tool). This avoids
                         * the popover going "all dashed" the moment the
                         * user disables AA on ellipse — only the ellipse
                         * entry should reflect that mode.
                         */}
                        <Icon
                          size={12}
                          className="shrink-0"
                          {...(active && s.supportsAntiAlias && isAntiAliased === false
                            ? ({ strokeDasharray: '3 3' } as React.SVGAttributes<SVGSVGElement>)
                            : {})}
                        />
                        {/* <span className="text-[10px] font-bold uppercase tracking-wide">
                          {s.label}
                        </span> */}
                      </button>
                    </React.Fragment>
                  );
                })}

                {/*
                 * Tool-strip close button — mirrors the Re-Canvas popover's
                 * "X" affordance (see the Re-Canvas Popover further down).
                 * Clicking dispatches `toggleModeCmd` which, given we are
                 * already in clip (the strip is `isOpen` only then), flips
                 * mode → 'pan' via the unified `exitClipMode` path. We
                 * intentionally use the *toggle* command rather than a
                 * direct `setInteraction({ interactionMode: 'pan' })`
                 * because `exitClipMode` schedules the deferred
                 * `mergeHost` microtask that commits any in-flight peel /
                 * exchange triplet — bypassing it would leak un-merged
                 * fragments into the document.
                 *
                 * NOTE: `toggleModeCmd` in clip mode CYCLES the active
                 * tool, it does NOT exit clip. The exit path is
                 * `exitClipCmd` (Esc). We surface that here as the
                 * affordance of the "X" — see commands.ts for the full
                 * matrix.
                 */}
                <div className="mx-1 w-px h-5 bg-[var(--border-subtle)]" />
                <button
                  onClick={() => exitClipModeCmd?.execute()}
                  className="flex items-center justify-center w-6 h-6 text-[var(--text-muted)] hover:text-rose-500 hover:bg-[var(--bg-stage)] rounded-md transition-colors"
                  title={`Exit Clip Mode (${exitClipModeCmd?.shortcutLabel || 'Esc'})`}
                >
                  <X size={12} />
                </button>

              </div>

            }
          >

            <button
              onClick={() => toggleModeCmd?.execute()}
              disabled={isReCanvas}
              className={`flex items-center justify-center w-8 h-7 rounded-l-xl transition-colors group outline-none select-none
                ${isReCanvas ? disabledClasses : "hover:bg-[var(--bg-stage)]"}
              `}
              title={`Toggle Mode (${toggleModeCmd?.shortcutLabel || ""})`}
            >
              {isPanMode ? (
                <Hand size={13} className="text-[var(--text-muted)]" />
              ) : (
                // `dashedIconProps` injects `strokeDasharray="3 3"` when the
                // current tool supports AA and AA is OFF — see comment block
                // above `dashedIconProps` for the rationale.
                <ToolIcon size={13} className={toolVisual.textClass} {...dashedIconProps} />
              )}

            </button>
          </Popover>


          <div className="w-[1px] h-3 bg-zinc-300 dark:bg-white/20" />

          {/*
           * Segment 2: AA toggle. Orthogonal to tool identity — reads
           * `supportsAntiAlias` from the active tool's strategy row to decide
           * its `disabled` state. Strikethrough on the `AA` glyph signals OFF
           * without needing a second icon. Wired to `CMD_TOGGLE_ANTI_ALIAS`.
           */}
          {(() => {
            const aaDisabled = isPanMode || isReCanvas || !supportsAntiAlias;
            return (
              <button
                onClick={() => antiAliasToggleCmd?.execute()}
                disabled={aaDisabled}
                className={`flex items-center justify-center w-7 h-7 transition-colors outline-none select-none
                  ${aaDisabled ? disabledClasses : "hover:bg-[var(--bg-stage)]"}
                `}
                title={
                  !supportsAntiAlias
                    ? "Anti-aliasing only applies to the Ellipse tool"
                    : `Anti-Alias: ${isAntiAliased ? "ON" : "OFF"}${antiAliasToggleCmd?.shortcutLabel ? ` (${antiAliasToggleCmd.shortcutLabel})` : ""}`
                }


              >
                <span
                  className={`text-[10px] font-black tracking-tight transition-colors ${
                    isAntiAliased && supportsAntiAlias && !aaDisabled
                      ? "text-amber-600 dark:text-amber-500"
                      : "text-[var(--text-muted)]"
                  } ${
                    !isAntiAliased && supportsAntiAlias && !aaDisabled
                      ? "line-through decoration-2"
                      : ""
                  }`}
                >
                  AA
                </span>
              </button>
            );
          })()}

          <div className="w-[1px] h-3 bg-zinc-300 dark:bg-white/20" />

          {/*
           * Segment 3: Aspect Ratio Selector — disabled on irregular tools (§3.2.4).
           *
           * ─── Popover migration (2026-06-23) ───────────────────────────
           * Previously the aspect grid was a portal-less `motion.div`
           * absolutely positioned at `top-full left-0`. It worked, but:
           *   1) it could be clipped by parent `overflow: hidden` (e.g.
           *      inside narrow toolbar containers),
           *   2) it had no arrow / shared "bubble" chrome, making it
           *      visually inconsistent with the sibling clip-tool strip
           *      and Re-Canvas popovers in this same file,
           *   3) z-index management was ad-hoc (a hard-coded `z-50`).
           * Migrating to `<Popover>` (portal + shared theme + arrow
           * anchoring) gives us free dark-mode theming, escape / outside
           * click semantics, and the same visual language as the other
           * two popovers on this toolbar.
           *
           * Hover-to-open / hover-to-close UX is preserved by:
           *   - `isOpen` bound to local `isDropdownOpen` state,
           *   - mouse handlers on BOTH the trigger button AND the popover
           *     content (so moving the cursor onto the bubble doesn't
           *     trigger the leave timeout),
           *   - dismissOnOutsideClick / dismissOnEscape kept ON, with
           *     `onClose` flipping the same state — gives users a
           *     keyboard/click escape hatch in addition to hover-out.
           */}
          <Popover
            isOpen={isDropdownOpen && !isPanMode && !isIrregularTool}
            onClose={() => setIsDropdownOpen(false)}
            position="bottom"
            align="start"
            offset={6}
            display="inline-flex"
            content={
              <div
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                className="w-48 p-1.5"
              >
                <AspectGrid
                  activeAspect={activeAspect}
                  onSelect={(val) => {
                    setAspectCmd?.execute({ aspect: val });
                    setIsDropdownOpen(false);
                  }}
                />
              </div>
            }
          >
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
          </Popover>
        </div>
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
            onClick={() => applyMaskCmd?.execute({ toolId: cropTool })}

            title="Apply Selection as Mask"
            variant="ghost"
            tooltipPosition="bottom"
            className="w-6 h-6"
          >
            <ScissorsLineDashed size={13} className="text-purple-500" />
          </FunctionButton>
        )}

        {/*
         * Re-Canvas — clickable from both pan and clip mode. The
         * `toggleReCanvas` command auto-promotes pan → clip when activating
         * the signal, so a single click from pan lands in "clip + re-canvas"
         * directly. The width / height inputs and APPLY button live in a
         * `Popover` whose lifecycle is bound to `isReCanvas` (mirrors the
         * tool-strip popover pattern in segment 1) — opening / closing the
         * Re-Canvas signal directly mounts / unmounts the bubble. Outside
         * click and Esc are deliberately *not* dismissable: closing must go
         * through `closeReCanvas` (which also clears the signal) or
         * `reCanvasApplyCmd` (which commits + closes), so we don't get into
         * a "popover hidden but signal still on" zombie state.
         */}
        <Popover
          isOpen={isReCanvas}
          onClose={() => { /* lifecycle bound to isReCanvas — outside click & Esc must NOT dismiss */ }}
          position="bottom"
          align="start"
          offset={8}
          dismissOnOutsideClick={false}
          dismissOnEscape={false}
          display="inline-flex"
          content={
            // Padding rationale: the bubble (`popover-bubble` in
            // `widgets/Popover.tsx`) carries **no** intrinsic padding, so
            // each consumer's content `div` is solely responsible for the
            // gap between text/controls and the rounded border. The
            // aspect-ratio popover sets `p-1.5` (6px) on a grid whose
            // tiles already have `p-2` of their own → ~14px effective
            // gap, which reads as airy. Re-Canvas previously had `p-1`
            // (4px) with `<input>` borders sitting almost flush against
            // the bubble edge, giving it a noticeably tighter visual.
            // Bumping to `p-2.5` (10px) brings it in line with the
            // aspect popover's optical weight while keeping the bubble
            // compact (we don't need `p-3+` because the W/H inputs
            // themselves are only 24px tall).
            <div className="flex flex-col gap-2.5 p-2.5 min-w-[160px]">
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
            </div>
          }
        >
          <FunctionButton
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
        </Popover>

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
