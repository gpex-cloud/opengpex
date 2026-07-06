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

   if (!sequence) {
      return (
         <div className="flex flex-col items-center justify-center py-6 text-center opacity-50">
            <Clapperboard size={24} className="text-[var(--text-muted)] mb-2" />
            <p className="text-[10px] text-[var(--text-muted)]">
               No animation sequence detected
            </p>
         </div>
      );
   }

   return (
      <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
         {/* Header */}
         <div className="flex justify-between items-center h-7 shrink-0">
             <div className="flex items-center gap-2">
                <Clapperboard size={12} className="text-indigo-600 dark:text-indigo-400" />
               <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
                  Animation
               </span>
               <span className="ml-1 text-[8px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded shadow-sm border border-emerald-500/20 uppercase">
                  {sequence.type}
               </span>
            </div>
         </div>

         {/* Playback Controls */}
         <PlayerBar state={player.state} actions={player.actions} />

         {/* Export Controls */}
         <AnimationExport
            config={exportCtl.config}
            updateConfig={exportCtl.updateConfig}
            exportAnimationCmd={exportCtl.exportAnimationCmd}
            sequence={sequence}
         />
      </div>
   );
}
