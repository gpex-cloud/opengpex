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

import React, { useRef, useState, useEffect } from "react";
import { Palette, PaintBucket, Pin, Pipette } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { ColorPickerPro } from "@opengpex/editor/widgets/ColorPickerPro";
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import PluginSlot from "@opengpex/editor/workspace/components/PluginSlot";
import { useColorOptions } from "./hooks";
import { COLOR_OPTIONS_CRAFT_SLOT } from "./protocols";

export const ColorOptionsComponent = React.memo(
  function ColorOptionsComponent() {
    const {
      currentColor,
      applyColor,
      fillAsLayerCmd,
      sampleColor,
      activeFrame,
    } = useColorOptions();

    const containerRef = useRef<HTMLDivElement>(null);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [isPinned, setIsPinned] = useState(false);

    const handleCommitColor = () => {
      // Optional: push to recents, or trigger a definitive final change
    };

    // Close dropdown on click outside (only if not pinned)
    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (isPinned) return; // Don't close if pinned
        if (
          containerRef.current &&
          !containerRef.current.contains(event.target as Node)
        ) {
          setIsDropdownOpen(false);
        }
      };
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }, [isPinned]);

    const handleMouseLeave = () => {
      if (!isPinned) {
        setIsDropdownOpen(false);
      }
    };

    if (!activeFrame) return null;

    return (
      <div className="flex items-center gap-1 -mr-1 animate-in fade-in slide-in-from-left-2 duration-300">
        {/* 1. Header Section */}
        <div className="flex items-center">
          <div className="flex items-center gap-1">
            <Palette size={12} className="text-[var(--text-muted)]" />
            <div className="w-12 flex justify-center hidden lg:flex">
              <span className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest">
                Color
              </span>
            </div>
          </div>
        </div>

        {/* Group 2: Actions */}
        <div className="relative flex items-center" ref={containerRef}>
          <div
            className={`relative flex items-center h-7 rounded-xl transition-all border shadow-sm
          ${
            isDropdownOpen
              ? "bg-[var(--bg-panel)] border-amber-500/50 shadow-lg"
              : "bg-[var(--bg-panel)] border-[var(--border-subtle)] hover:border-[var(--border-light)]"
          }
        `}
          >
            {typeof window !== "undefined" && "EyeDropper" in window && (
              <>
                <Tooltip content="Sample Color" position="bottom" display="inline-flex">
                  <button
                    onClick={sampleColor}
                    className="flex items-center justify-center w-8 h-full rounded-l-xl transition-all hover:bg-[var(--bg-stage)] outline-none group"
                  >
                    <Pipette
                      size={13}
                      className="text-[var(--text-muted)] group-hover:text-amber-500 transition-colors"
                    />
                  </button>
                </Tooltip>
                <div className="w-[1px] h-3 bg-zinc-300 dark:bg-white/20 shrink-0" />
              </>
            )}

            <Tooltip content="Pick Color" position="bottom" display="inline-flex">
              <button
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className={`flex items-center justify-center w-8 h-full transition-colors outline-none hover:bg-[var(--bg-stage)] 
                ${!(typeof window !== "undefined" && "EyeDropper" in window) ? "rounded-l-xl" : ""}
              `}
              >
                <div
                  className="w-4 h-4 rounded shadow-inner ring-1 ring-black/10 dark:ring-white/10 transition-transform active:scale-90"
                  style={{ backgroundColor: currentColor }}
                />
              </button>
            </Tooltip>

            <div className="w-[1px] h-3 bg-zinc-300 dark:bg-white/20 shrink-0" />

            <Tooltip content={`${fillAsLayerCmd?.name || "Fill"} (${fillAsLayerCmd?.shortcutLabel || ""})`} position="bottom" display="inline-flex">
              <button
                onClick={() =>
                  fillAsLayerCmd?.execute({ fillColor: currentColor })
                }
                className="flex items-center justify-center w-8 h-full rounded-r-xl transition-all hover:bg-[var(--bg-stage)] outline-none group relative"
              >
                {/* Subtle color glow background */}
                <div
                  className="absolute inset-0 opacity-0 group-hover:opacity-10 transition-opacity rounded-r-xl"
                  style={{ backgroundColor: currentColor }}
                />
                <PaintBucket
                  size={13}
                  className="transition-all transform group-active:scale-95"
                  style={{
                    color: currentColor,
                    filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.1))",
                  }}
                />
              </button>
            </Tooltip>
          </div>

          {/* Floating Dropdown Picker */}
          <AnimatePresence>
            {isDropdownOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 5 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 5 }}
                transition={{ duration: 0.15 }}
                onMouseLeave={handleMouseLeave}
                className="absolute top-full mt-3 bg-[var(--bg-panel)] backdrop-blur-xl border border-[var(--border-subtle)] rounded-2xl shadow-2xl overflow-hidden z-[999] p-3 ring-1 ring-black/5"
              >
                <div className="flex justify-between items-center mb-2">
                  {typeof window !== "undefined" && "EyeDropper" in window ? (
                    <Tooltip content="Pick color from screen" position="bottom" display="inline-flex">
                      <button
                        onClick={sampleColor}
                        className="p-1 rounded-md transition-colors text-[var(--text-muted)] hover:text-amber-500 hover:bg-[var(--bg-stage)] group"
                      >
                        <Pipette
                          size={14}
                          className="group-hover:scale-110 transition-transform"
                        />
                      </button>
                    </Tooltip>
                  ) : (
                    <div />
                  )}
                  <Tooltip content={isPinned ? "Unpin" : "Pin Color Picker"} position="bottom" display="inline-flex">
                    <button
                      onClick={() => setIsPinned(!isPinned)}
                      className={`p-1 rounded-md transition-colors ${isPinned ? "text-amber-500 bg-amber-500/10" : "text-[var(--text-muted)] hover:bg-[var(--bg-stage)]"}`}
                    >
                      <Pin size={14} className={isPinned ? "fill-current" : ""} />
                    </button>
                  </Tooltip>
                </div>
                <ColorPickerPro
                  color={currentColor}
                  onChange={applyColor}
                  onCommit={handleCommitColor}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Craft Tool Slot: tool trigger buttons contributed by other plugins (CraftDrawer) */}
        <PluginSlot
          name={COLOR_OPTIONS_CRAFT_SLOT}
          className="flex items-center ml-1"
        />
      </div>
    );
  },
);
