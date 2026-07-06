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

import { Clapperboard } from "lucide-react";

import { useAnimationPlayer, useAnimationExport } from "./hooks";
import { PlayerBar } from "./components/PlayerBar";
import { AnimationExport } from "./components/AnimationExport";

/**
 * AnimationComponent: Main plugin component for animation playback and export.
 *
 * Automatically detects GIF/APNG animation sequences in the active frame.
 * Provides playback controls and animated format export capabilities.
 */
export function AnimationComponent() {
   const player = useAnimationPlayer();
   const exportCtl = useAnimationExport();

   const { sequence } = player.state;

   return (
      <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
         {/* Header — always visible */}
         <div className="flex justify-between items-center shrink-0">
            <div className="flex items-center gap-2">
               <Clapperboard size={12} className="text-indigo-600 dark:text-indigo-400" />
               <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
                  Animation
               </span>
               {sequence && (
                  <span className="ml-1 text-[8px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded shadow-sm border border-emerald-500/20 uppercase">
                     {sequence.type}
                  </span>
               )}
            </div>
         </div>

         {/* Content: sequence detected → playback + export; otherwise → placeholder */}
         {sequence ? (
            <>
               <PlayerBar state={player.state} actions={player.actions} />
               <AnimationExport
                  config={exportCtl.config}
                  updateConfig={exportCtl.updateConfig}
                  exportAnimationCmd={exportCtl.exportAnimationCmd}
                  sequence={sequence}
                  onRecalculateFps={player.actions.recalculateFps}
               />
            </>
         ) : (
            <div className="flex flex-col bg-[var(--bg-stage)] p-4 rounded-xl border border-[var(--border-subtle)] items-center justify-center py-8 text-center gap-2">
               <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest">
                  No Animation Detected
               </span>
               <span className="text-[9px] text-[var(--text-muted)] tracking-tight leading-relaxed">
                  Open an animated GIF to enable playback and export controls.
               </span>
            </div>
         )}
      </div>
   );
}
