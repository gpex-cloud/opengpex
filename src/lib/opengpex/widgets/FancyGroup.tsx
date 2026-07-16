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
import { createPortal } from "react-dom";

/* ─────────────────────────── Types ─────────────────────────── */

export type FancyGroupSize = "xs" | "sm" | "md";

export interface FancyGroupItem {
  /** Unique key for the item. */
  key: string;
  /** Icon element (lucide or custom SVG). */
  icon: React.ReactNode;
  /** Tooltip text shown on hover. */
  tooltip?: string;
  /** Click handler. */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Whether this item is active/selected. */
  active?: boolean;
  /** Whether this item is disabled. */
  disabled?: boolean;
  /** Additional className for the button. */
  className?: string;
  /** Custom content to render instead of just icon (e.g. color swatch). */
  render?: (props: { className: string }) => React.ReactNode;
}

export type FancyGroupShape = "rounded" | "pill";

export interface FancyGroupProps {
  /** Array of button items to render in the group. */
  items: FancyGroupItem[];
  /** Size variant. Default: 'sm'. */
  size?: FancyGroupSize;
  /** Shape of the group ends. 'rounded' uses size-based radius; 'pill' uses fully rounded ends. Default: 'pill'. */
  shape?: FancyGroupShape;
  /** Whether the group is in "active/highlighted" state (e.g. dropdown open). */
  highlighted?: boolean;
  /** Additional className for the outer container. */
  className?: string;
}

/* ─────────────────────────── Size Config ─────────────────────────── */

const SIZE_CONFIG: Record<FancyGroupSize, {
  height: string;
  buttonWidth: string;
  separatorH: string;
}> = {
  xs: { height: "h-6", buttonWidth: "w-7", separatorH: "h-2.5" },
  sm: { height: "h-7", buttonWidth: "w-8", separatorH: "h-3" },
  md: { height: "h-8", buttonWidth: "w-9", separatorH: "h-3.5" },
};

const SHAPE_CONFIG: Record<FancyGroupShape, {
  radius: string;
  radiusL: string;
  radiusR: string;
}> = {
  rounded: { radius: "rounded-xl", radiusL: "rounded-l-xl", radiusR: "rounded-r-xl" },
  pill:    { radius: "rounded-full", radiusL: "rounded-l-full", radiusR: "rounded-r-full" },
};

/* ─────────────────────────── Inline Tooltip ─────────────────────────── */

/**
 * Lightweight inline tooltip — renders via portal, matches project Tooltip styling.
 * Does NOT wrap the trigger element (avoiding the parent-height problem).
 */
function InlineTooltip({ text, anchorRect }: { text: string; anchorRect: DOMRect | null }) {
  if (!anchorRect || !text) return null;

  const offset = 8;
  const top = anchorRect.top + anchorRect.height + offset;
  const left = anchorRect.left + anchorRect.width / 2;

  return createPortal(
    <div
      style={{
        position: "fixed",
        top,
        left,
        transform: "translateX(-50%)",
        zIndex: 10100,
        pointerEvents: "none",
      }}
      className="whitespace-nowrap animate-in fade-in zoom-in-95 duration-200"
    >
      <div className="bg-white dark:bg-zinc-900 text-zinc-800 dark:text-white text-[10px] rounded-lg py-1.5 px-2.5 shadow-2xl border border-zinc-200 dark:border-white/10 uppercase font-bold tracking-wider">
        {text}
      </div>
      {/* Arrow */}
      <div className="border-4 border-transparent w-0 h-0 absolute bottom-full left-1/2 -translate-x-1/2 border-b-white dark:border-b-zinc-900 border-l-transparent border-r-transparent border-t-0" />
    </div>,
    document.body
  );
}

/* ─────────────────────────── FancyGroup Component ─────────────────────────── */

export default function FancyGroup({
  items,
  size = "sm",
  shape = "pill",
  highlighted = false,
  className = "",
}: FancyGroupProps) {
  const config = SIZE_CONFIG[size];
  const shapeConfig = SHAPE_CONFIG[shape];
  const [tooltipState, setTooltipState] = useState<{ text: string; rect: DOMRect } | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showTooltip = useCallback((text: string, el: HTMLElement) => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    // Suppress if inside a container marked to suppress tooltips
    if (el.closest(".suppress-tooltips")) return;
    const rect = el.getBoundingClientRect();
    setTooltipState({ text, rect });
  }, []);

  const hideTooltip = useCallback(() => {
    hideTimerRef.current = setTimeout(() => {
      setTooltipState(null);
    }, 50);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  // Update tooltip position on scroll/resize
  useEffect(() => {
    if (!tooltipState) return;
    const handleScroll = () => setTooltipState(null);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [tooltipState]);

  return (
    <>
      <div
        className={`relative flex items-stretch ${config.height} ${shapeConfig.radius} transition-all border shadow-sm
          ${highlighted
            ? "bg-[var(--bg-panel)] border-amber-500/50 shadow-lg"
            : "bg-[var(--bg-panel)] border-[var(--border-subtle)] hover:border-[var(--border-light)]"
          } ${className}`}
      >
        {items.map((item, index) => {
          const isFirst = index === 0;
          const isLast = index === items.length - 1;

          // Determine border-radius class for position in group
          const posRadius = isFirst && isLast
            ? shapeConfig.radius
            : isFirst
              ? shapeConfig.radiusL
              : isLast
                ? shapeConfig.radiusR
                : "";

          // Separator before this button (skip first)
          const separator = !isFirst ? (
            <div
              key={`sep-${item.key}`}
              className={`w-[1px] ${config.separatorH} self-center bg-zinc-300 dark:bg-white/20 shrink-0`}
            />
          ) : null;

          const buttonEl = item.render ? (
            <div
              key={item.key}
              className={`relative flex items-center justify-center ${config.buttonWidth} h-full ${posRadius} transition-all hover:bg-[var(--bg-stage)] outline-none cursor-pointer group ${item.active ? "bg-[var(--bg-stage)]" : ""} ${item.disabled ? "opacity-40 pointer-events-none" : ""} ${item.className || ""}`}
              onMouseEnter={(e) => item.tooltip && showTooltip(item.tooltip, e.currentTarget)}
              onMouseLeave={hideTooltip}
              onClick={item.onClick as unknown as React.MouseEventHandler<HTMLDivElement>}
            >
              {item.render({ className: `${config.buttonWidth} h-full ${posRadius}` })}
            </div>
          ) : (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              disabled={item.disabled}
              onMouseEnter={(e) => item.tooltip && showTooltip(item.tooltip, e.currentTarget)}
              onMouseLeave={hideTooltip}
              className={`relative flex items-center justify-center ${config.buttonWidth} h-full ${posRadius} transition-all hover:bg-[var(--bg-stage)] outline-none group cursor-pointer ${item.active ? "bg-[var(--bg-stage)]" : ""} ${item.disabled ? "opacity-40 cursor-not-allowed" : ""} ${item.className || ""}`}
            >
              {item.icon}
            </button>
          );

          return (
            <React.Fragment key={item.key}>
              {separator}
              {buttonEl}
            </React.Fragment>
          );
        })}
      </div>

      {/* Portal-based tooltip */}
      {tooltipState && typeof document !== "undefined" && (
        <InlineTooltip text={tooltipState.text} anchorRect={tooltipState.rect} />
      )}
    </>
  );
}

export { FancyGroup };
