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
import Tooltip, { TooltipPosition, TooltipAlign } from "./Tooltip";

export type FancyButtonVariant =
  | "red"
  | "green"
  | "blue"
  | "indigo"
  | "amber"
  | "zinc"
  | "gray"
  | "ghost"
  | "unstyled";
export type FancyButtonShape = "rect" | "pill";
export type FancyButtonSize = "xs" | "sm" | "md" | "lg";

interface FancyButtonProps {
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  loading?: boolean;
  children?: React.ReactNode;
  /** Tooltip content shown on hover. Does NOT affect button layout. Alias: `tooltip`. */
  title?: React.ReactNode;
  /** Alias for `title`. Tooltip content shown on hover. */
  tooltip?: React.ReactNode;
  className?: string;
  active?: boolean;
  variant?: FancyButtonVariant;
  subtle?: boolean;
  shape?: FancyButtonShape;
  size?: FancyButtonSize;
  iconOnly?: boolean;
  tooltipAlign?: TooltipAlign;
  tooltipPosition?: TooltipPosition;
}

const VARIANT_THEMES: Record<
  FancyButtonVariant,
  { solid: string; subtle: string; active: string }
> = {
  green: {
    solid:
      "bg-emerald-600 text-white hover:bg-emerald-500 border border-emerald-500/20 shadow-sm",
    subtle:
      "bg-emerald-600/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-600 hover:text-white hover:border-emerald-500 shadow-sm",
    active: "bg-emerald-700 text-white border-emerald-600 shadow-inner",
  },
  indigo: {
    solid:
      "bg-indigo-600 text-white hover:bg-indigo-500 border border-indigo-500/20 shadow-sm",
    subtle:
      "bg-indigo-600/10 text-indigo-500 border border-indigo-500/20 hover:bg-indigo-600 hover:text-white hover:border-indigo-500 shadow-sm",
    active: "bg-indigo-700 text-white border-indigo-600 shadow-inner",
  },
  amber: {
    solid:
      "bg-amber-600 text-white hover:bg-amber-500 border border-amber-500/20 shadow-sm",
    subtle:
      "bg-amber-600/10 text-amber-500 border border-amber-500/20 hover:bg-amber-600 hover:text-white hover:border-amber-500 shadow-sm",
    active: "bg-amber-700 text-white border-amber-600 shadow-inner",
  },
  red: {
    solid:
      "bg-rose-600 text-white hover:bg-rose-500 border border-rose-500/20 shadow-sm",
    subtle:
      "bg-rose-600/10 text-rose-500 border border-rose-500/30 hover:bg-rose-600 hover:text-white hover:border-rose-500 shadow-sm",
    active: "bg-rose-700 text-white border-rose-600 shadow-inner",
  },
  blue: {
    solid:
      "bg-blue-600 text-white hover:bg-blue-500 border border-blue-500/20 shadow-sm",
    subtle:
      "bg-blue-600/10 text-blue-500 border border-blue-500/30 hover:bg-blue-600 hover:text-white hover:border-blue-500 shadow-sm",
    active: "bg-blue-700 text-white border-blue-600 shadow-inner",
  },
  zinc: {
    solid:
      "bg-zinc-900 text-zinc-50 border-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100 dark:hover:bg-zinc-200",
    subtle:
      "bg-zinc-100 text-zinc-700 border-zinc-200 hover:bg-zinc-200/80 dark:bg-zinc-800 dark:text-zinc-200 dark:border-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-50",
    active:
      "bg-zinc-200 text-zinc-900 border-zinc-300 dark:bg-zinc-950 dark:text-white dark:border-zinc-800 shadow-inner",
  },
  gray: {
    solid:
      "bg-zinc-100 text-zinc-800 hover:bg-zinc-200 border border-zinc-200",
    subtle:
      "bg-zinc-100/10 text-zinc-400 border border-zinc-700/10 hover:bg-zinc-200 hover:text-zinc-800",
    active: "bg-zinc-300 text-zinc-900 border-zinc-400 shadow-inner",
  },
  ghost: {
    solid:
      "text-zinc-500 hover:text-zinc-900 dark:hover:text-white border-transparent hover:bg-zinc-800/5 dark:hover:bg-white/5",
    subtle:
      "text-zinc-500 hover:text-zinc-900 dark:hover:text-white border-transparent hover:bg-zinc-800/5 dark:hover:bg-white/5",
    active: "text-indigo-500 dark:text-indigo-400 border-zinc-200 dark:border-white/5",
  },
  unstyled: {
    solid: "",
    subtle: "",
    active: "",
  },
};

const ICON_ONLY_SIZES: Record<FancyButtonSize, string> = {
  xs: "w-7 h-7 text-[10px]",
  sm: "w-8 h-8 text-[11px]",
  md: "w-9 h-9 text-xs",
  lg: "w-10 h-10 text-sm",
};

const STANDARD_SIZES: Record<FancyButtonSize, string> = {
  xs: "text-[9px] px-2 h-7 gap-1",
  sm: "text-[10px] px-2.5 h-8 gap-1",
  md: "text-xs px-3.5 h-9 gap-1.5",
  lg: "text-sm px-4 h-10 gap-1.5",
};

/**
 * mergeClasses: Utility to merge Tailwind classes, resolving standard overrides.
 */
export function mergeClasses(
  ...classes: (string | undefined | null | boolean)[]
) {
  const list = classes.filter(Boolean) as string[];
  const merged: Record<string, string> = {};
  const customClasses: string[] = [];

  const prefixes = [
    "bg-",
    "border-",
    "w-",
    "h-",
    "min-w-",
    "min-h-",
    "p-",
    "px-",
    "py-",
    "rounded-",
    "font-",
    "shadow-",
    "gap-",
  ];

  for (const c of list) {
    const parts = c.split(/\s+/);
    for (const part of parts) {
      if (!part) continue;

      let matched = false;
      const statePrefixMatch = part.match(
        /^((?:[a-z0-9-]+:)+)?([a-z0-9-]+-)(.*)$/
      );
      if (statePrefixMatch) {
        const state = statePrefixMatch[1] || "";
        const prefix = statePrefixMatch[2];
        const suffix = statePrefixMatch[3];
        if (prefix === "text-") {
          const isTextSize = /^(xs|sm|base|lg|xl|[2-9]xl|\[\d+(?:px|em|rem|%)?\])$/.test(suffix);
          const key = state + (isTextSize ? "text-size" : "text-color");
          merged[key] = part;
          matched = true;
        } else if (prefixes.includes(prefix)) {
          const key = state + prefix;
          merged[key] = part;
          matched = true;
        }
      } else {
        if (part.startsWith("text-")) {
          const suffix = part.substring(5);
          const isTextSize = /^(xs|sm|base|lg|xl|[2-9]xl|\[\d+(?:px|em|rem|%)?\])$/.test(suffix);
          const key = isTextSize ? "text-size" : "text-color";
          merged[key] = part;
          matched = true;
        } else {
          for (const prefix of prefixes) {
            if (part.startsWith(prefix)) {
              merged[prefix] = part;
              matched = true;
              break;
            }
          }
        }
      }

      if (!matched) {
        customClasses.push(part);
      }
    }
  }

  return [...Object.values(merged), ...customClasses].join(" ");
}

export function FancyButton({
  onClick,
  disabled,
  loading = false,
  children,
  title,
  tooltip,
  className = "",
  active = false,
  variant = "ghost",
  subtle = false,
  shape = "pill",
  size = "md",
  iconOnly = false,
  tooltipAlign = "center",
  tooltipPosition = "top",
  ...props
}: FancyButtonProps & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  // tooltip and title are aliases — tooltip takes precedence if both provided
  const resolvedTooltip = tooltip ?? title;

  const getVariantStyles = () => {
    const theme = VARIANT_THEMES[variant];
    if (!theme) return "";
    if (active) return theme.active;
    return subtle ? theme.subtle : theme.solid;
  };

  const roundedClass = shape === "pill" ? "rounded-full" : "rounded-xl";
  const sizeClass = iconOnly ? ICON_ONLY_SIZES[size] : STANDARD_SIZES[size];

  const titleStr = typeof resolvedTooltip === "string" ? resolvedTooltip : "";
  const match = titleStr.match(/^(.*?)\s*\((.*?)\)$/);
  const label = match ? match[1] : titleStr;
  const shortcut = match ? match[2] : undefined;

  const buttonContent = (
    <button
      onClick={onClick}
      onMouseUp={(e) => e.currentTarget.blur()}
      onTouchEnd={(e) => e.currentTarget.blur()}
      disabled={disabled || loading}
      data-label={label || undefined}
      data-shortcut={shortcut || undefined}
      data-active={active || undefined}
      onKeyDown={(e) => {
        if (e.key === " ") {
          e.preventDefault();
        }
      }}
      className={mergeClasses(
        "relative flex items-center justify-center gap-1.5 transition-all duration-300",
        "shrink-0 border font-bold uppercase cursor-pointer focus:outline-none",
        "disabled:opacity-20 disabled:cursor-not-allowed active:scale-[0.96]",
        roundedClass,
        sizeClass,
        getVariantStyles(),
        className
      )}
      {...props}
    >
      {loading && (
        <svg
          className="animate-spin h-3.5 w-3.5"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          ></circle>
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          ></path>
        </svg>
      )}
      {children}
    </button>
  );

  if (resolvedTooltip) {
    return (
      <Tooltip
        content={resolvedTooltip}
        align={tooltipAlign}
        position={tooltipPosition}
        display="inline-flex"
        containerClassName={className}
      >
        {buttonContent}
      </Tooltip>
    );
  }

  return buttonContent;
}

export default FancyButton;
