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

import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { PRO_GAMUTS } from "../types";
import ChannelInput from "@opengpex/editor/widgets/ChannelInput";
import type { GamutId } from "@opengpex/editor/core/types/primitives";

interface ProGamutSectionProps {
  proMode: boolean;
  onToggleProMode: () => void;
  /**
   * The current frame's gamut (§5.4 / decision A: full lock). Display-only —
   * there is no user-triggerable switch, so this can never write back to
   * storage on a mere view action.
   */
  gamut: GamutId;
  coords: { r: number; g: number; b: number };
  alpha: number;
  cssReadout: string;
}

export function ProGamutSection({
  proMode,
  onToggleProMode,
  gamut,
  coords,
  alpha,
  cssReadout,
}: ProGamutSectionProps) {
  const [copiedCss, setCopiedCss] = useState(false);
  const gamutLabel = PRO_GAMUTS.find((g) => g.id === gamut)?.label ?? gamut;

  return (
    <>
      <div className="w-full h-px bg-zinc-200/80 dark:bg-white/8" />
      <div className="flex flex-col gap-1.5">
        <button
          onClick={onToggleProMode}
          className="flex items-center justify-between group"
          title="Wide-gamut Pro mode"
        >
          <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 transition-colors">
            Pro · Wide Gamut
          </span>
          <span
            className={`relative w-7 h-4 rounded-full transition-colors ${
              proMode ? "bg-indigo-500" : "bg-zinc-300 dark:bg-white/15"
            }`}
          >
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all ${
                proMode ? "left-3.5" : "left-0.5"
              }`}
            />
          </span>
        </button>

        {proMode && (
          <div className="flex flex-col gap-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
            {/* Locked document gamut — display-only, never switchable (§5.4). */}
            <div className="flex items-center gap-1.5">
              <span
                className="px-1.5 py-0.5 rounded text-[9px] font-semibold text-indigo-700 dark:text-indigo-200 bg-indigo-500/15 ring-1 ring-indigo-500/30"
                title="Document colour space — follows the current frame"
              >
                {gamutLabel}
              </span>
              <span className="text-[9px] font-medium text-zinc-400">
                Document color space
              </span>
            </div>

            {/* Wide gamut numerical coordinates */}
            <div className="flex items-center gap-1.5">
              <ChannelInput
                readOnly
                title={cssReadout}
                channels={[
                  { key: "r", label: "R:", value: coords.r.toFixed(4) },
                  { key: "g", label: "G:", value: coords.g.toFixed(4) },
                  { key: "b", label: "B:", value: coords.b.toFixed(4) },
                  ...(alpha < 1
                    ? [
                        {
                          key: "a",
                          label: "/",
                          value: alpha.toFixed(2),
                          muted: true,
                        },
                      ]
                    : []),
                ]}
              />
              <button
                onClick={() => {
                  navigator.clipboard.writeText(cssReadout);
                  setCopiedCss(true);
                  setTimeout(() => setCopiedCss(false), 1500);
                }}
                className="flex items-center justify-center w-6 h-6 rounded-md bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 transition-all shrink-0"
                title={`Copy CSS: ${cssReadout}`}
              >
                {copiedCss ? (
                  <Check size={10} className="text-emerald-500" />
                ) : (
                  <Copy size={10} />
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
