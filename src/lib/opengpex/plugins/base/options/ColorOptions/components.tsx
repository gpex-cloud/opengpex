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
import { Palette, PaintBucket, Pin } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { ColorPickerPro } from "@opengpex/editor/widgets/ColorPickerPro";
import { ColorSampler, SAMPLER_CHROME_ATTR } from "./ColorSampler";
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import SplitButton from "@opengpex/editor/widgets/SplitButton";
import type { ActionOption } from "@opengpex/editor/widgets/ActionDropdown";
import FancyGroup, { type FancyGroupItem } from "@opengpex/editor/widgets/FancyGroup";
import PluginSlot from "@opengpex/editor/workspace/components/PluginSlot";
import { useColorOptions } from "./hooks";
import {
  COLOR_OPTIONS_CRAFT_SLOT,
  samplerStripTools,
  samplerBarTools,
  type SamplerTool,
  type SamplerToolStrategy,
} from "./protocols";

export const ColorOptionsComponent = React.memo(
  function ColorOptionsComponent() {
    const {
      currentColor,
      applyColor,
      fillAsLayerCmd,
      sampleColor,
      isSampling,
      handleSampled,
      cancelSampling,
      activeFrame,
      snapshot,
      onRequestSnapshot,
      captureExactAt,
      releaseSnapshot,
      geometry,
      getCamera,
      sampleAllLayers,
      activeSamplerTool,
      samplerToolSetCmd,
      frameGamut,
      autoExpandPro,
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
        <div
          className="relative flex items-center"
          ref={containerRef}
          {...{ [SAMPLER_CHROME_ATTR]: "" }}
        >
          <FancyGroup
            size="xs"
            highlighted={isDropdownOpen || isSampling}
            items={(() => {
              const groupItems: FancyGroupItem[] = [];

              // Canvas sampler SplitButton — compact, memorized between All Layers and Current Layer.
              // Selecting from dropdown updates the tool and immediately closes without occluding ColorPickerPro.
              const samplerDropdownOptions: ActionOption[] = (
                samplerStripTools() as SamplerToolStrategy[]
              ).map((s) => {
                const Icon = s.icon;
                return {
                  value: s.id,
                  label: s.label,
                  icon: <Icon size={13} />,
                };
              });

              groupItems.push({
                key: "sample",
                element: (
                  <SplitButton
                    compact
                    borderless
                    active={isSampling}
                    value={activeSamplerTool}
                    onChange={(val) => {
                      samplerToolSetCmd?.execute({ tool: val as SamplerTool });
                    }}
                    onClick={sampleColor}
                    dropdownOptions={samplerDropdownOptions}
                    tooltip={`Sample ${sampleAllLayers ? "All Layers" : "Current Layer"} (i)`}
                  />
                ),
              });

              // Bar-surface sampler tools (`surface: 'bar'`) — currently just
              // the native screen picker. It sits beside the pipette rather
              // than inside the strip because it is a peer ENTRY POINT: it does
              // not need canvas sampling to be running, and it is momentary, so
              // it has no "active" state and is outside the Tab cycle. Hidden
              // entirely where `window.EyeDropper` is missing (its own gate).
              for (const s of samplerBarTools() as SamplerToolStrategy[]) {
                const Icon = s.icon;
                groupItems.push({
                  key: `tool-${s.id}`,
                  tooltip: s.label,
                  onClick: () => samplerToolSetCmd?.execute({ tool: s.id }),
                  icon: (
                    <Icon
                      size={13}
                      className="text-zinc-800 dark:text-zinc-200 transition-colors group-hover:text-indigo-500"
                    />
                  ),
                });
              }

              // Color swatch / pick color button
              groupItems.push({
                key: "pick",
                tooltip: "Pick Color",
                onClick: () => setIsDropdownOpen(!isDropdownOpen),
                icon: (
                  <div
                    className="w-4 h-4 rounded shadow-inner ring-1 ring-zinc-500 dark:ring-zinc-200 transition-transform active:scale-90"
                    style={{ backgroundColor: currentColor.hex }}
                  />
                ),
              });

              // Fill button with color glow
              groupItems.push({
                key: "fill",
                tooltip: `${fillAsLayerCmd?.name || "Fill"} (${fillAsLayerCmd?.shortcutLabel || ""})`,
                onClick: () => fillAsLayerCmd?.execute({ fillColor: currentColor }),
                icon: (
                  <>
                    {/* Subtle color glow background */}
                    <div
                      className="absolute inset-0 opacity-0 group-hover:opacity-10 transition-opacity rounded-r-xl"
                      style={{ backgroundColor: currentColor.hex }}
                    />
                    <PaintBucket
                      size={13}
                      className="text-zinc-800 dark:text-zinc-200 transition-all transform group-active:scale-95"
                      style={{
                        filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.1))",
                      }}
                    />
                  </>
                ),
              });

              return groupItems;
            })()}
          />

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
                <ColorPickerPro
                  value={currentColor}
                  onValueChange={applyColor}
                  onValueCommit={handleCommitColor}
                  enablePro
                  frameGamut={frameGamut}
                  autoExpandPro={autoExpandPro}
                  headerRight={
                    <Tooltip content={isPinned ? "Unpin" : "Pin Color Picker"} position="bottom" display="inline-flex">
                      <button
                        onClick={() => setIsPinned(!isPinned)}
                        className={`p-1.5 rounded-lg transition-colors ${
                          isPinned
                            ? "text-amber-500 bg-amber-500/10"
                            : "text-[var(--text-muted)] hover:bg-[var(--bg-stage)] hover:text-[var(--text-normal)]"
                        }`}
                      >
                        <Pin size={13} className={isPinned ? "fill-current" : ""} />
                      </button>
                    </Tooltip>
                  }
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

        {/* ColorSampler: WebGPU snapshot pixel sampler overlay */}
        <ColorSampler
          active={isSampling}
          snapshot={snapshot}
          onRequestSnapshot={onRequestSnapshot}
          captureExact={captureExactAt}
          onReleaseSnapshot={releaseSnapshot}
          frame={activeFrame}
          geometry={geometry}
          getCamera={getCamera}
          currentLayerOnly={!sampleAllLayers}
          onSample={handleSampled}
          onCancel={cancelSampling}
        />
      </div>
    );
  },
);
