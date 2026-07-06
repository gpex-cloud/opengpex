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

import React, { useState } from "react";
import { Download } from "lucide-react";
import FancyButton from "@opengpex/editor/widgets/FancyButton";
import type { CommandInstance } from "@opengpex/editor/core/types";
import type { AnimationConfig } from "../protocols";
import type { AnimationSequence } from "../hooks";

interface AnimationExportProps {
   config: AnimationConfig;
   updateConfig: (cfg: Partial<AnimationConfig>) => void;
   exportAnimationCmd?: CommandInstance;
   sequence: AnimationSequence | null;
}

/**
 * AnimationExport: Export panel for animated sequences.
 *
 * Provides format selection, loop count, and frame rate override controls.
 */
export const AnimationExport = React.memo(function AnimationExport({
   config,
   updateConfig,
   exportAnimationCmd,
   sequence,
}: AnimationExportProps) {
   const [isProcessing, setIsProcessing] = useState(false);

   if (!sequence) return null;

   const handleExport = async () => {
      setIsProcessing(true);
      try {
         await exportAnimationCmd?.execute();
      } finally {
         setIsProcessing(false);
      }
   };

   const totalDurationSec = (sequence.totalDuration / 1000).toFixed(1);
   const avgFps = sequence.totalFrames > 0
      ? Math.round(sequence.totalFrames / (sequence.totalDuration / 1000))
      : 0;

   return (
      <div className="mt-2 pt-2 border-t border-[var(--border-subtle)] space-y-2.5">
         <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-widest block">
            Export Animation
         </span>

         {/* Info row */}
         <div className="flex items-center gap-3 text-[9px] text-[var(--text-muted)]">
            <span className="tabular-nums">{sequence.totalFrames} frames</span>
            <span className="tabular-nums">{totalDurationSec}s</span>
            <span className="tabular-nums">~{avgFps} fps</span>
         </div>

         {/* Frame rate override */}
         <div className="flex items-center gap-2 px-1">
            <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-10">
               FPS
            </span>
            <input
               type="range"
               min="0"
               max="30"
               value={config.frameRateOverride}
               onChange={(e) => updateConfig({ frameRateOverride: parseInt(e.target.value) })}
               onMouseUp={(e) => e.currentTarget.blur()}
               onTouchEnd={(e) => e.currentTarget.blur()}
               style={{ accentColor: config.frameRateOverride > 0 ? '#10b981' : '#666666' }}
               className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border border-[var(--border-subtle)] shadow-inner"
            />
            <span className="text-[10px] font-black w-12 text-right tabular-nums text-[var(--text-muted)]">
               {config.frameRateOverride > 0 ? `${config.frameRateOverride}` : 'Auto'}
            </span>
         </div>

         {/* Export button row */}
         <div className="flex gap-2 pt-1">
             <FancyButton
                disabled={true}
                variant="zinc"
                subtle={true}
                size="xs"
                className="w-16"
             >
                GIF
             </FancyButton>
             <FancyButton
                onClick={handleExport}
                disabled={isProcessing}
                loading={isProcessing}
                variant="green"
                size="xs"
                className="flex-1"
             >
               {!isProcessing && <Download size={12} className="text-white/80" />}
               <span className="uppercase">
                  {isProcessing ? "Encoding..." : "Export Animation"}
               </span>
            </FancyButton>
         </div>
      </div>
   );
});
