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

import { RefreshCw } from "lucide-react";

import {
  GPU_BROWSER_GUIDANCE,
  GPU_UNAVAILABLE_EXPLANATION,
  GPU_UNAVAILABLE_RELOAD_LABEL,
  GPU_UNAVAILABLE_TITLE,
} from "@opengpex/editor/core/engine/gpu/GpuAvailability";

interface GpuUnavailableHintProps {
  /**
   * - "fullscreen": replaces the whole page (S1 — navigator.gpu missing).
   *   Rendered before the workspace chunk ever loads.
   * - "overlay": covers the canvas area inside the workspace (S2/S3 —
   *   adapter/device acquisition failed at mount). The caller supplies the
   *   stacking context (z-index seat).
   */
  variant?: "fullscreen" | "overlay";
  /** Inline style for the outer container (e.g. z-index seat). */
  style?: React.CSSProperties;
}

/**
 * WebGPU-unavailable hint page (A7 — hint only).
 *
 * Advisory surface with a one-line explanation, per-platform browser
 * guidance and a reload button. By product decision this is NOT a fallback:
 * it never substitutes editor functionality, never intercepts flows and
 * never links to a legacy editor. Visual family follows the workspace zinc
 * palette (same tokens as LandingPage / FancyOverlay).
 */
export default function GpuUnavailableHint({
  variant = "overlay",
  style,
}: GpuUnavailableHintProps) {
  return (
    <div
      className={
        variant === "fullscreen"
          ? "fixed inset-0 flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4 select-none"
          : "absolute inset-0 flex items-center justify-center bg-zinc-50/95 dark:bg-zinc-950/95 backdrop-blur-sm px-4 select-none"
      }
      style={style}
    >
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/70 p-6 text-center">
        <h1 className="text-base font-bold text-zinc-800 dark:text-zinc-200">
          {GPU_UNAVAILABLE_TITLE}
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          {GPU_UNAVAILABLE_EXPLANATION}
        </p>

        <ul className="mt-4 space-y-1.5 text-left">
          {GPU_BROWSER_GUIDANCE.map((entry) => (
            <li
              key={entry.platform}
              className="flex items-baseline justify-between gap-3 rounded-lg border border-zinc-200/70 dark:border-zinc-800/70 px-3 py-1.5"
            >
              <span className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-300">
                {entry.platform}
              </span>
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {entry.browsers}
              </span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-zinc-800 dark:bg-zinc-200 px-4 py-2 text-xs font-semibold text-zinc-50 dark:text-zinc-900 outline-none transition-colors hover:bg-zinc-700 dark:hover:bg-zinc-300"
        >
          <RefreshCw size={12} strokeWidth={2.5} />
          {GPU_UNAVAILABLE_RELOAD_LABEL}
        </button>
      </div>
    </div>
  );
}
