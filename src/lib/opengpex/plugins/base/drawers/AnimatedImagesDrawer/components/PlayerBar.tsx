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

import React, { useCallback, useRef } from "react";
import { Play, Pause, Square, SkipBack, SkipForward, Repeat } from "lucide-react";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import type { AnimatedImagesPlayerState, AnimatedImagesPlayerActions } from "../hooks";

interface AnimatedImagesPlayerBarProps {
   state: AnimatedImagesPlayerState;
   actions: AnimatedImagesPlayerActions;
}

/**
 * PlayerBar: Animation playback controls.
 *
 * Renders Play/Pause/Stop/Prev/Next buttons with a SEEKABLE progress bar.
 * Format-agnostic — works with any animation sequence type.
 */
export const PlayerBar = React.memo(function PlayerBar({ state, actions }: AnimatedImagesPlayerBarProps) {
   const { currentIndex, isPlaying, loopEnabled, totalFrames, progress, sequence } = state;
   const barRef = useRef<HTMLDivElement>(null);
   const scrubbingRef = useRef(false);

   /** Map a pointer x within the bar to a frame index. */
   const indexFromEvent = useCallback(
      (e: React.PointerEvent): number => {
         const rect = barRef.current?.getBoundingClientRect();
         if (!rect || rect.width === 0 || totalFrames <= 1) return 0;
         const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
         return Math.round(ratio * (totalFrames - 1));
      },
      [totalFrames],
   );

   // Scrub contract: the playhead follows the pointer live through the cheap
   // channel for the current mode, while the SELECTION write lands exactly
   // once — on pointer-up. A drag would otherwise fire dozens of
   // setActiveLayer dispatches.
   const onPointerDown = (e: React.PointerEvent) => {
      if (totalFrames <= 1) return;
      scrubbingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      actions.seekTo(indexFromEvent(e), { select: false });
   };
   const onPointerMove = (e: React.PointerEvent) => {
      if (!scrubbingRef.current) return;
      actions.seekTo(indexFromEvent(e), { select: false });
   };
   const onPointerUp = (e: React.PointerEvent) => {
      if (!scrubbingRef.current) return;
      scrubbingRef.current = false;
      actions.seekTo(indexFromEvent(e)); // default: select the target layer
   };

   if (!sequence) return null;

   return (
      <div className="space-y-2">
         <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-lite shrink-0" />
            <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-widest">
               {sequence.type.toUpperCase()} Animation
            </span>
            <span className="text-[9px] font-bold text-[var(--text-muted)] tabular-nums ml-auto">
               {currentIndex + 1} / {totalFrames}
            </span>
         </div>

         {/* Progress bar — clickable / draggable seek */}
          <div
             ref={barRef}
             onPointerDown={onPointerDown}
             onPointerMove={onPointerMove}
             onPointerUp={onPointerUp}
             className="h-2.5 -my-0.5 w-full flex items-center cursor-pointer touch-none"
          >
             <div className="h-1 w-full bg-[var(--bg-stage)] rounded-full overflow-hidden border border-[var(--border-subtle)]">
                <div
                   className="h-full bg-teal-400/60 transition-none rounded-full"
                   style={{ width: `${progress}%` }}
                />
             </div>
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
