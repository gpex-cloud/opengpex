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

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";

/**
 * VerticalTabs — floating book-page side tabs for drawer plugins whose tool
 * families outgrow a horizontal switcher (the LayerEffectsDrawer's PS-style
 * family: ten+ effect kinds will never fit the AdjustmentDrawer-style
 * header rail).
 *
 * LAYOUT CONTRACT ("full-width panel + Portal-floating rail"):
 * - The panel (`children`) ALWAYS spans the widget's full width — the rail
 *   never takes layout space, so the parameter area is never squeezed.
 * - The tab rail renders through a PORTAL into `document.body` as a
 *   `position: fixed` layer: hovering the panel reveals a rail that sits
 *   MOSTLY OUTSIDE the panel's left border (only its spine overlaps the
 *   panel edge) and above every drawer chrome — ancestor `overflow` clipping
 *   and stacking contexts cannot clip or bury it, which plain absolute
 *   positioning inside the widget cannot guarantee.
 * - The ACTIVE tab keeps the book-page merge: panel background, square spine
 *   edge facing the panel, no divider — it reads as one page protruding from
 *   the panel body even while floating outside it.
 * - Hover bridging: the rail stays open while the pointer is on the panel OR
 *   on the rail itself (the rail is outside the widget's DOM subtree, so a
 *   short close-delay bridges the crossing between the two surfaces).
 */

export interface VerticalTabItem {
  /** Stable identity — also the `activeId` selector. */
  id: string;
  /** Row label (effect name). */
  label: string;
  /** Optional leading icon (category glyph). */
  icon?: React.ReactNode;
  /** Optional trailing control rendered after the label (eye toggle, jump button...). */
  trailing?: React.ReactNode;
  /** Optional left accent bar color classes (shown in both active and inactive states). */
  indicatorClassName?: string;
  /** Disabled tabs are non-interactive and dimmed. */
  disabled?: boolean;
}

export interface VerticalTabsProps {
  items: VerticalTabItem[];
  /** The currently selected tab id. */
  activeId: string;
  /** Tab click handler (selection only — trailing controls handle their own clicks). */
  onSelect: (id: string) => void;
  /** Horizontal offset (px) from the panel's left edge (negative pushes toward outer drawer edge). */
  spineOffsetPx?: number;
  /** The main panel content shown for the active tab (rendered by the owner). */
  children?: React.ReactNode;
  className?: string;
}

/** Offset of the rail's spine from the panel's left edge (px). 0 = flush: the
 * tabs hug the panel edge, protruding entirely OUTSIDE it — the active tab's
 * panel-matching background + square spine still fuse it visually to the body. */
const SPINE_OVERLAP_PX = 0;
/** Close delay bridging the pointer crossing between panel and floating rail (ms). */
const CLOSE_DELAY_MS = 120;
/** Edge fade mask height when the vertical tab rail overflows (px). */
const EDGE_FADE_PX = 16;
/** Safe inset from scrolled edges so the active tab clears the fade zone (px). */
const ACTIVE_SCROLL_INSET_PX = EDGE_FADE_PX + 4;

export const VerticalTabs = React.memo(function VerticalTabs({
  items,
  activeId,
  onSelect,
  spineOffsetPx = SPINE_OVERLAP_PX,
  children,
  className = "",
}: VerticalTabsProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [edgeFade, setEdgeFade] = useState({ top: false, bottom: false });
  /**
   * Which side of the panel the rail protrudes from. Defaults to the panel's
   * left (the drawer body sits to the rail's right); flips to the right side
   * whenever the left placement would push the rail off the viewport's left
   * edge — the case when the drawer itself is docked at the screen's left
   * (or the window is too narrow), where a left rail is unreachable.
   */
  const [side, setSide] = useState<"left" | "right">("left");

  const updateEdgeFade = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const top = rail.scrollTop > 2;
    const bottom = rail.scrollTop + rail.clientHeight < rail.scrollHeight - 2;
    setEdgeFade((prev) =>
      prev.top === top && prev.bottom === bottom ? prev : { top, bottom },
    );
  }, []);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancelClose]);

  const openNow = useCallback(() => {
    cancelClose();
    setAnchorRect(anchorRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  }, [cancelClose]);

  /**
   * Hover keep-alive. `mouseenter` alone is not sufficient: transient layout
   * shifts while the rail renders (framer-motion `layout` re-measures in the
   * owning drawer) can synthesize a mouseleave mid-panel, arming the close
   * timer with no re-entry to cancel it — the rail then "dies" while the
   * pointer is still on the panel. Tracking pointer movement over the panel
   * re-asserts openness every frame the pointer is genuinely inside.
   */
  const keepOpen = useCallback(() => {
    if (!open) {
      openNow();
      return;
    }
    cancelClose();
  }, [open, openNow, cancelClose]);

  // Reposition the fixed rail while open (drawer scroll, window resize).
  useEffect(() => {
    if (!open) return;
    const reposition = (e?: Event) => {
      // Scrolling inside the rail itself never moves the panel anchor.
      if (e?.target === railRef.current) return;
      const next = anchorRef.current?.getBoundingClientRect() ?? null;
      setAnchorRect((prev) => {
        if (!prev || !next) return next;
        if (
          Math.abs(prev.left - next.left) < 0.5 &&
          Math.abs(prev.top - next.top) < 0.5 &&
          Math.abs(prev.height - next.height) < 0.5
        ) {
          return prev;
        }
        return next;
      });
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  // Side selection. The rail's own rendered width decides: if anchoring on
  // the panel's left edge would push the rail past the viewport's left edge,
  // flip to the panel's right edge. The rail exists only while open (portal),
  // so the measurement runs after it mounts and again whenever the anchor
  // moves; a drawer dragged across the screen re-evaluates continuously.
  useEffect(() => {
    if (!open || !anchorRect) return;
    const rail = railRef.current;
    const width = rail?.offsetWidth ?? 0;
    const offScreenLeft = anchorRect.left + spineOffsetPx - width < 8;
    setSide((prev) => {
      const next = offScreenLeft ? "right" : "left";
      return prev === next ? prev : next;
    });
  }, [open, anchorRect, spineOffsetPx, items.length]);

  // Keep the ACTIVE tab inside the crisp (non-faded) viewport of the rail:
  // `scrollIntoView({ block: 'nearest' })` lands flush against the edge and
  // would leave the active tab inside the EDGE_FADE_PX mask zone. Instead,
  // scroll only when needed and leave ACTIVE_SCROLL_INSET_PX of clearance
  // from any scrolled edge (clamped to 0 / maxScroll for first/last tabs,
  // where the corresponding edge fade is off anyway).
  useEffect(() => {
    if (!open) return;
    const rail = railRef.current;
    if (!rail) return;
    const activeEl = rail.querySelector<HTMLElement>('[aria-selected="true"]');
    if (activeEl) {
      const railRect = rail.getBoundingClientRect();
      const activeRect = activeEl.getBoundingClientRect();
      const relTop = activeRect.top - railRect.top;
      const relBottom = activeRect.bottom - railRect.top;
      const inset = Math.min(
        ACTIVE_SCROLL_INSET_PX,
        Math.max(0, (rail.clientHeight - activeRect.height) / 2),
      );
      if (relTop < inset) {
        rail.scrollTop = Math.max(0, rail.scrollTop - (inset - relTop));
      } else if (relBottom > rail.clientHeight - inset) {
        rail.scrollTop += relBottom - (rail.clientHeight - inset);
      }
    }
    updateEdgeFade();
  }, [open, activeId, items.length, anchorRect?.height, updateEdgeFade]);


  // NOTE: no rail measurement is needed — `translateX(-100%)` shifts the rail
  // by its OWN rendered width, so the fixed anchor (`left`) always lands the
  // spine exactly SPINE_OVERLAP px inside the panel edge regardless of how
  // wide the labels grow.

  const railStyle: React.CSSProperties | null = anchorRect
    ? {
        position: "fixed",
        // LEFT side: the rail's right edge sits spineOffsetPx px from the
        // panel's left border, protruding outside the panel bounds
        // (translateX(-100%) shifts it by its own width — no measurement
        // needed for the anchor itself). RIGHT side: mirrored — the rail's
        // left edge sits spineOffsetPx px inside the panel's right border.
        left:
          side === "left"
            ? anchorRect.left + spineOffsetPx
            : anchorRect.right - spineOffsetPx,
        top: anchorRect.top,
        transform: side === "left" ? "translateX(-100%)" : "none",
        maxHeight: anchorRect.height,
        // Window segment: the rail is a body-level portal that must float
        // above every drawer chrome, same band as ActionDropdown menus.
        zIndex: EDITOR_Z_INDEX.WINDOW.CONTEXT_MENU,
      }
    : null;

  const topStop = edgeFade.top ? `transparent 0px, black ${EDGE_FADE_PX}px` : "black 0px";
  const bottomStop = edgeFade.bottom
    ? `black calc(100% - ${EDGE_FADE_PX}px), transparent 100%`
    : "black 100%";
  const maskGradient =
    edgeFade.top || edgeFade.bottom
      ? `linear-gradient(to bottom, ${topStop}, ${bottomStop})`
      : undefined;

  return (
    <div
      ref={anchorRef}
      className={`relative min-h-0 w-full ${className}`}
      onMouseEnter={openNow}
      onMouseMove={keepOpen}
      onMouseLeave={scheduleClose}
    >
      {/* Panel body — transparent so content sits directly on the drawer's
          own backdrop (matching AnimatedImagesDrawer) without an inner box. */}
      <div role="tabpanel" className="w-full min-h-0">
        {children}
      </div>

      {mounted &&
        railStyle &&
        createPortal(
          <AnimatePresence>
            {open && (
              <div style={railStyle}>
                <motion.div
                  ref={railRef}
                  role="tablist"
                  aria-orientation="vertical"
                  initial={{ opacity: 0, x: side === "left" ? 6 : -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: side === "left" ? 6 : -6 }}
                  transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                  style={{
                    maxHeight: anchorRect?.height,
                    maskImage: maskGradient,
                    WebkitMaskImage: maskGradient,
                  }}
                  className={[
                    // Transparent container (no outer box): extra outer-side
                    // padding gives individual tab shadows room without
                    // clipping — LEFT side pads left, RIGHT side pads right.
                    side === "left"
                      ? "flex flex-col gap-[3px] pl-3 pr-0 py-0.5"
                      : "flex flex-col gap-[3px] pr-3 pl-0 py-0.5",
                    "overflow-y-auto",
                    "[&::-webkit-scrollbar]:hidden [scrollbar-width:none] [scrollbar-gutter:stable]",
                  ].join(" ")}
                  onScroll={updateEdgeFade}
                  onMouseEnter={openNow}
                  onMouseLeave={scheduleClose}
                >
                  {items.map((item) => {
                    const active = item.id === activeId;
                    return (
                      <button
                        key={item.id}
                        role="tab"
                        aria-selected={active}
                        disabled={item.disabled}
                        onClick={() => !active && !item.disabled && onSelect(item.id)}
                        className={[
                          // Mirror everything on the flipped side: the spine
                          // edge (square corner + border) always faces the
                          // panel, the ear protrudes away from it.
                          side === "left"
                            ? "relative flex items-center gap-1.5 py-1.5 pl-3 rounded-l-lg rounded-r-none text-left transition-colors duration-150 outline-none cursor-pointer whitespace-nowrap"
                            : "relative flex items-center gap-1.5 py-1.5 pr-3 rounded-r-lg rounded-l-none text-right transition-colors duration-150 outline-none cursor-pointer whitespace-nowrap",
                          active
                            // Active book-page ear: panel-matching surface, crisp
                            // hairline border, and elevated shadow.
                            ? side === "left"
                              ? "pl-3 pr-3 bg-[var(--bg-panel)] border-y border-l border-zinc-200/90 dark:border-white/[0.12] font-semibold text-zinc-900 dark:text-zinc-100 shadow-[-4px_2px_10px_rgba(0,0,0,0.08)] dark:shadow-[-4px_2px_12px_rgba(0,0,0,0.45)]"
                              : "pl-3 pr-3 bg-[var(--bg-panel)] border-y border-r border-zinc-200/90 dark:border-white/[0.12] font-semibold text-zinc-900 dark:text-zinc-100 shadow-[4px_2px_10px_rgba(0,0,0,0.08)] dark:shadow-[4px_2px_12px_rgba(0,0,0,0.45)]"
                            // Inactive bookmark: crisp high-opacity surface without
                            // per-item backdrop-blur so scrolling stays cheap over WebGPU.
                            : side === "left"
                              ? "pl-3 pr-2.5 bg-zinc-100/95 dark:bg-zinc-900/95 border-y border-l border-zinc-200/70 dark:border-white/[0.07] font-medium text-zinc-500 dark:text-zinc-400 shadow-[-2px_1px_6px_rgba(0,0,0,0.05)] dark:shadow-[-2px_1px_8px_rgba(0,0,0,0.28)] hover:bg-white dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-300/80 dark:hover:border-white/[0.12]"
                              : "pl-2.5 pr-3 bg-zinc-100/95 dark:bg-zinc-900/95 border-y border-r border-zinc-200/70 dark:border-white/[0.07] font-medium text-zinc-500 dark:text-zinc-400 shadow-[2px_1px_6px_rgba(0,0,0,0.05)] dark:shadow-[2px_1px_8px_rgba(0,0,0,0.28)] hover:bg-white dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-300/80 dark:hover:border-white/[0.12]",
                          item.disabled ? "opacity-40 cursor-not-allowed" : "",
                        ].join(" ")}
                      >
                        {(item.indicatorClassName || active) && (
                          <span
                            aria-hidden="true"
                            className={`absolute ${
                              side === "left" ? "left-1" : "right-1"
                            } top-1/2 -translate-y-1/2 w-[2.5px] h-3 rounded-full ${
                              item.indicatorClassName ?? "bg-indigo-500 dark:bg-indigo-400"
                            }`}
                          />
                        )}
                        {item.icon && <span className="shrink-0 flex items-center">{item.icon}</span>}
                        <span className="text-[10px] tracking-tight truncate">{item.label}</span>
                        {item.trailing && (
                          <span
                            className="ml-auto shrink-0 flex items-center"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {item.trailing}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </motion.div>
              </div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
});

export default VerticalTabs;
