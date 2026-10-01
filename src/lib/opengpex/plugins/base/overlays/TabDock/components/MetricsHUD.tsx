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
import { Activity, MemoryStick, Cpu, Minus } from "lucide-react";
import { useEditorServices } from "@opengpex/editor/core/context";

export interface MetricsHUDProps {
  onCollapse?: () => void;
}

function fpsColor(fps: number): string {
  if (fps >= 50) return "text-emerald-500";
  if (fps >= 30) return "text-amber-500";
  return "text-rose-500";
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function parseVendor(vendor: string, architecture: string): string {
  const tokens = `${vendor} ${architecture}`.toLowerCase();
  if (tokens.includes("apple")) return "MAC";
  if (tokens.includes("nvidia")) return "NVIDIA";
  if (
    tokens.includes("amd") ||
    tokens.includes("ati") ||
    tokens.includes("advanced micro")
  )
    return "AMD";
  if (tokens.includes("intel")) return "INTEL";
  if (tokens.includes("qualcomm") || tokens.includes("adreno")) return "ADRENO";
  if (tokens.includes("arm") || tokens.includes("mali")) return "MALI";
  if (vendor.trim()) return vendor.trim().slice(0, 6).toUpperCase();
  return "GPU";
}

/**
 * MetricsHUD: Compact FPS + JS Heap Mem + GPU Current Mem + Vendor display for TabDock.
 */
export function MetricsHUD({ onCollapse }: MetricsHUDProps) {
  const { pixels } = useEditorServices();

  // 1. RAF-driven FPS counter
  const [fps, setFps] = useState(0);
  const fpsRef = useRef({ frames: 0, lastTime: 0 });

  useEffect(() => {
    fpsRef.current = { frames: 0, lastTime: performance.now() };
    let rafId: number;
    const fpsTick = () => {
      const now = performance.now();
      fpsRef.current.frames++;
      const elapsed = now - fpsRef.current.lastTime;
      if (elapsed >= 1000) {
        setFps(Math.round((fpsRef.current.frames * 1000) / elapsed));
        fpsRef.current = { frames: 0, lastTime: now };
      }
      rafId = requestAnimationFrame(fpsTick);
    };
    rafId = requestAnimationFrame(fpsTick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // 2. Memory & GPU Diagnostics (1s interval)
  const [metrics, setMetrics] = useState({
    mem: null as string | null,
    gpuMem: "0 MB",
    vendor: "GPU",
    tooltip: "",
  });

  useEffect(() => {
    const collect = () => {
      // JS Heap
      const perf = performance as Performance & {
        memory?: { usedJSHeapSize: number };
      };
      const heapStr = perf.memory ? formatMB(perf.memory.usedJSHeapSize) : null;

      // GPU diagnostics via PixelFacade
      let gpuStr = "0 MB";
      let vdrStr = "GPU";
      let tip = "GPU: Initializing";

      try {
        const info = pixels?.system?.gpuInfo?.();
        if (info) {
          const currentOccupied =
            info.memory.inUseBytes + info.memory.compositeTargetBytes;
          gpuStr = formatMB(currentOccupied);
          vdrStr = parseVendor(
            info.adapterInfo.vendor,
            info.adapterInfo.architecture,
          );

          const tipLines = [
            info.adapterInfo.device ||
              info.adapterInfo.description ||
              `GPU Adapter (${vdrStr})`,
            info.adapterInfo.vendor
              ? `Vendor: ${info.adapterInfo.vendor}`
              : null,
            info.adapterInfo.architecture
              ? `Arch: ${info.adapterInfo.architecture}`
              : null,
            `Format: ${info.workingFormat}`,
            `Composite Target: ${formatMB(info.memory.compositeTargetBytes)}`,
            `Max Texture: ${info.limits.maxTextureDimension2D}px`,
          ].filter(Boolean);

          tip = tipLines.join("\n");
        }
      } catch {
        // PixelFacade not yet ready or non-GPU environment
      }

      setMetrics({
        mem: heapStr,
        gpuMem: gpuStr,
        vendor: vdrStr,
        tooltip: tip,
      });
    };

    collect();
    const timer = setInterval(collect, 1000);
    return () => clearInterval(timer);
  }, [pixels]);

  return (
    <div
      className="relative flex flex-col gap-1.5 font-mono select-none group/hud"
      title={metrics.tooltip}
    >
      {/* Collapse button: floats over the HUD's top-right corner, takes no layout space.
          Acts as a shortcut for the Metrics HUD toggle in settings. */}
      {onCollapse && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCollapse();
          }}
          title="Hide Metrics HUD"
          aria-label="Hide Metrics HUD"
          className="absolute -top-2 -right-2 z-[1200] flex items-center justify-center w-3.5 h-3.5 rounded-full bg-zinc-700 text-white hover:bg-zinc-600 dark:bg-zinc-300 dark:text-zinc-900 dark:hover:bg-zinc-200 border border-black/10 dark:border-white/10 opacity-0 group-hover/hud:opacity-100 transition-all shadow-sm"
        >
          <Minus size={8} strokeWidth={3} />
        </button>
      )}

      {/* Row 1: FPS */}
      <div className="flex items-center gap-1">
        <Activity size={8} className={`shrink-0 ${fpsColor(fps)}`} />
        <span className="text-[7px] font-black text-[var(--text-muted)] uppercase leading-none w-[18px]">
          FPS
        </span>
        <span
          className={`text-[9px] font-black tabular-nums leading-none ${fpsColor(fps)}`}
        >
          {fps}
        </span>
      </div>

      {/* Row 2: JS Heap Memory */}
      {metrics.mem !== null && (
        <div className="flex items-center gap-1">
          <MemoryStick size={8} className="text-violet-400 shrink-0" />
          <span className="text-[7px] font-black text-[var(--text-muted)] uppercase leading-none w-[18px]">
            MEM
          </span>
          <span className="text-[9px] font-bold text-[var(--text-muted)] tabular-nums leading-none">
            {metrics.mem}
          </span>
        </div>
      )}

      {/* Row 3: GPU (Current occupancy: in-use pool + composite target) */}
      <div className="flex items-center gap-1">
        <Cpu size={8} className="text-amber-400 shrink-0" />
        <span className="text-[7px] font-black text-[var(--text-muted)] uppercase leading-none w-[18px]">
          GPU
        </span>
        <span className="text-[9px] font-bold text-[var(--text-muted)] tabular-nums leading-none">
          {metrics.gpuMem}
        </span>
      </div>
    </div>
  );
}

export default MetricsHUD;
