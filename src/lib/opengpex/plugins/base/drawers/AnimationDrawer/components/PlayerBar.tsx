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
import { Play, Pause, Square, SkipBack, SkipForward, Repeat } from "lucide-react";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import type { AnimationPlayerState, AnimationPlayerActions } from "../hooks";

interface PlayerBarProps {
   state: AnimationPlayerState;
   actions: AnimationPlayerActions;
}

/**
 * PlayerBar: Animation playback controls.
 *
 * Renders Play/Pause/Stop/Prev/Next buttons with progress bar.
 * Format-agnostic — works with any animation sequence type.
 */
export const PlayerBar = React.memo(function PlayerBar({ state, actions }: PlayerBarProps) {
   const { currentIndex, isPlaying, loopEnabled, totalFrames, progress, sequence } = state;

   if (!sequence) return null;

   return (
      <div className="space-y-2">
         <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-widest">
               {sequence.type.toUpperCase()} Animation
            </span>
            <span className="text-[9px] font-bold text-[var(--text-muted)] tabular-nums ml-auto">
               {currentIndex + 1} / {totalFrames}
            </span>
         </div>

         {/* Progress bar */}
          <div className="h-1 w-full bg-[var(--bg-stage)] rounded-full overflow-hidden border border-[var(--border-subtle)]">
             <div
                className="h-full bg-teal-400/60 transition-all duration-75 rounded-full"
                style={{ width: `${progress}%` }}
             />
          </div>

         {/* Controls */}
         <div className="flex items-center justify-center gap-1 relative">
            <ActionButton
               onClick={actions.prevFrame}
               disabled={isPlaying}
               icon={<SkipBack size={12} />}
               tooltip="Previous Frame"
               variant="glass"
               size="sm"
               className="text-[var(--text-muted)] hover:text-[var(--text-main)]"
            />

            {isPlaying ? (
               <ActionButton
                  onClick={actions.pause}
                  icon={<Pause size={14} />}
                  tooltip="Pause"
                  variant="glass"
                  size="sm"
                  className="text-amber-500 hover:text-amber-400"
               />
            ) : (
               <ActionButton
                  onClick={actions.play}
                  icon={<Play size={14} />}
                  tooltip="Play"
                  variant="glass"
                  size="sm"
                  className="text-emerald-500 hover:text-emerald-400"
               />
            )}

            <ActionButton
               onClick={actions.stop}
               disabled={!isPlaying && currentIndex === 0}
               icon={<Square size={12} />}
               tooltip="Stop (Reset)"
               variant="glass"
               size="sm"
               className="text-[var(--text-muted)] hover:text-rose-500"
            />

            <ActionButton
               onClick={actions.nextFrame}
               disabled={isPlaying}
               icon={<SkipForward size={12} />}
               tooltip="Next Frame"
               variant="glass"
               size="sm"
               className="text-[var(--text-muted)] hover:text-[var(--text-main)]"
            />

            {/* Loop toggle — right-aligned */}
            <ActionButton
               onClick={actions.toggleLoop}
               icon={<Repeat size={11} />}
               tooltip={loopEnabled ? "Loop: ON" : "Loop: OFF"}
               variant="glass"
               size="sm"
               className={`absolute right-0 ${loopEnabled ? 'text-teal-400' : 'text-[var(--text-muted)] opacity-40'}`}
            />
         </div>
      </div>
   );
});
