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

'use client';

import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { useEditorState, useEditorServices, usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import { Frame, Layer } from '@opengpex/editor/core/types';
import { GifHandler } from '@opengpex/editor/core/files/handlers/gif';
import type { AnimationDrawerCommandsMap } from './commands.d';
import type { AnimationConfig } from './protocols';

// ═══════════════════════════════════════════════════════════════════════════════
// Animation Sequence Detection (format-agnostic)
// ═══════════════════════════════════════════════════════════════════════════════

export interface AnimationSequence {
   type: 'gif' | 'apng' | 'webp-anim';
   sequenceId: string;
   layers: Layer[];
   totalFrames: number;
   totalDuration: number; // ms
}

/**
 * Detect animation sequences in a frame by scanning layer metadata.
 * Supports multiple sequence types for future extensibility.
 */
export function detectAnimationSequences(frame: Frame): AnimationSequence[] {
   const hostLayers = frame.layers.order
      .map(id => frame.layers.byId[id])
      .filter((l): l is Layer => !!l && !l.hostId);

   // Group by gifSequenceId
   const gifGroups = new Map<string, Layer[]>();
   for (const layer of hostLayers) {
      const seqId = layer.metadata?.gifSequenceId as string | undefined;
      if (seqId) {
         if (!gifGroups.has(seqId)) gifGroups.set(seqId, []);
         gifGroups.get(seqId)!.push(layer);
      }
   }

   const sequences: AnimationSequence[] = [];
   for (const [sequenceId, layers] of gifGroups) {
      if (layers.length <= 1) continue;
      const sorted = layers.sort(
         (a, b) => ((a.metadata?.gifFrameIndex as number) || 0) - ((b.metadata?.gifFrameIndex as number) || 0),
      );
      const totalDuration = sorted.reduce(
         (sum, l) => sum + ((l.metadata?.gifFrameDelay as number) || 100),
         0,
      );
      sequences.push({
         type: 'gif',
         sequenceId,
         layers: sorted,
         totalFrames: sorted.length,
         totalDuration,
      });
   }

   // Future: detect apngSequenceId, webpAnimSequenceId, etc.

   return sequences;
}

// ═══════════════════════════════════════════════════════════════════════════════
// useAnimationPlayer: Smooth rAF-based playback with FPS override support
// ═══════════════════════════════════════════════════════════════════════════════

export interface AnimationPlayerState {
   sequence: AnimationSequence | null;
   currentIndex: number;
   isPlaying: boolean;
   isWarming: boolean; // Pre-warm phase (loading spinner)
   loopEnabled: boolean;
   totalFrames: number;
   progress: number; // 0-100
}

export interface AnimationPlayerActions {
   play: () => void;
   pause: () => void;
   stop: () => void;
   prevFrame: () => void;
   nextFrame: () => void;
   gotoFrame: (index: number) => void;
   toggleLoop: () => void;
   recalculateFps: () => void;
}

export function useAnimationPlayer(): {
   state: AnimationPlayerState;
   actions: AnimationPlayerActions;
} {
   const { activeFrame, state } = useEditorState();
   const { actions } = useEditorServices();
   const [selfConfig, setSelfConfig] = usePluginSelfConfig<AnimationConfig>();

   const [isPlaying, setIsPlaying] = useState(false);
   const [isWarming, setIsWarming] = useState(false);
   const [currentIndex, setCurrentIndex] = useState(0);

   const playingRef = useRef(false);
   const rafRef = useRef<number | null>(null);
   const lastFrameTimeRef = useRef(0);
   const currentIndexRef = useRef(0);
   const sequenceRef = useRef<AnimationSequence | null>(null);
   const configRef = useRef<AnimationConfig>(selfConfig);
   const warmedRef = useRef(false); // Texture cache pre-warm flag
   const animationLoopRef = useRef<((ts: number) => void) | null>(null);

   // Keep config ref up to date (via effect to avoid ref access during render)
   useEffect(() => { configRef.current = selfConfig; });

   // Detect animation sequence
   const sequence = useMemo(() => {
      if (!activeFrame) return null;
      const sequences = detectAnimationSequences(activeFrame);
      return sequences.length > 0 ? sequences[0] : null;
   }, [activeFrame]);

   // Keep sequence ref up to date (via effect to avoid ref access during render)
   useEffect(() => { sequenceRef.current = sequence; });

   /* eslint-disable react-hooks/refs */
   // Synchronously terminate playback if sequenceId changes during render phase (Solution B)
   const prevSequenceIdRef = useRef<string | null>(null);
   if (prevSequenceIdRef.current !== sequence?.sequenceId) {
      prevSequenceIdRef.current = sequence?.sequenceId || null;
      playingRef.current = false;
      if (rafRef.current) {
         cancelAnimationFrame(rafRef.current);
         rafRef.current = null;
      }
   }
   /* eslint-enable react-hooks/refs */

   // Reset playback state when sequence changes (e.g., user switches to another frame and back)
   useEffect(() => {
      // Stop any running animation loop
      if (rafRef.current) {
         cancelAnimationFrame(rafRef.current);
         rafRef.current = null;
      }
      playingRef.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional state reset on sequence change
      setIsPlaying(false);
      warmedRef.current = false; // Reset pre-warm cache for new sequence

      if (!sequence) return;
      const visibleIdx = sequence.layers.findIndex(l => l.visible !== false);
      if (visibleIdx >= 0) {
         setCurrentIndex(visibleIdx);
         currentIndexRef.current = visibleIdx;
      }

   // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on sequenceId only, not sequence object
   }, [sequence?.sequenceId]);

   // Reactive FPS calculation: recalculates when sequence layers change
   // (e.g., user deletes frames, or switches to a different GIF)
   useEffect(() => {
      if (!sequence || sequence.totalFrames === 0) return;
      const delays = sequence.layers.map(l => (l.metadata?.gifFrameDelay as number) || 100);
      const fps = GifHandler.calculateFps(delays);
      setSelfConfig({ frameRateOverride: fps });
   // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on sequenceId + totalFrames, not full objects
   }, [sequence?.sequenceId, sequence?.totalFrames]);

   // Cleanup on unmount
   useEffect(() => {
      return () => {
         if (rafRef.current) cancelAnimationFrame(rafRef.current);
         playingRef.current = false;
      };
   }, []);

   /**
    * Show a specific frame: atomically set visibility for all sequence layers.
    * This is a single updateFrame call — no intermediate render between hide/show.
    */
   const showFrame = useCallback((index: number) => {
      if (!activeFrame || !sequenceRef.current) return;
      const seq = sequenceRef.current;
      if (index < 0 || index >= seq.totalFrames) return;

      // Build the entire updated byId map in one pass — atomic visibility switch
      const updatedById: Record<string, Layer> = { ...activeFrame.layers.byId };
      for (let i = 0; i < seq.layers.length; i++) {
         const layer = seq.layers[i];
         updatedById[layer.id] = { ...updatedById[layer.id], visible: i === index };
      }

      // Single atomic state update — no gap between hiding old frame and showing new one
      actions.updateFrame(activeFrame.id, {
         layers: { byId: updatedById, order: activeFrame.layers.order },
      });

      currentIndexRef.current = index;
      setCurrentIndex(index);
   }, [activeFrame, actions]);

   /**
    * Get the frame interval in ms.
    * If frameRateOverride > 0, use it (uniform timing for all frames).
    * Otherwise, use the per-frame gifFrameDelay from metadata.
    */
   const getFrameDelay = useCallback((index: number): number => {
      const fpsOverride = configRef.current?.frameRateOverride;
      if (fpsOverride && fpsOverride > 0) {
         return 1000 / fpsOverride;
      }
      // Use per-frame delay from metadata
      const seq = sequenceRef.current;
      if (!seq) return 100;
      const delay = (seq.layers[index]?.metadata?.gifFrameDelay as number) || 100;
      return delay;
   }, []);

   /**
    * requestAnimationFrame-based animation loop.
    * Accumulates elapsed time and advances frames when the delay threshold is met.
    * Respects loop config: when loop is off, stops at the last frame.
    */
   const animationLoop = useCallback((timestamp: number) => {
      if (!playingRef.current || !sequenceRef.current) return;

      const elapsed = timestamp - lastFrameTimeRef.current;
      const delay = getFrameDelay(currentIndexRef.current);

      if (elapsed >= delay) {
         const seq = sequenceRef.current;
         const isLastFrame = currentIndexRef.current === seq.totalFrames - 1;

         if (isLastFrame && !configRef.current?.loop) {
            // No loop: stop playback and reset to first frame
            playingRef.current = false;
            setIsPlaying(false);
            if (rafRef.current) {
               cancelAnimationFrame(rafRef.current);
               rafRef.current = null;
            }
            showFrame(0);
            return;
         }

         const nextIndex = (currentIndexRef.current + 1) % seq.totalFrames;
         showFrame(nextIndex);
         lastFrameTimeRef.current = timestamp;
      }

      rafRef.current = requestAnimationFrame((ts) => animationLoopRef.current?.(ts));
   }, [showFrame, getFrameDelay]);

   // Keep animationLoop ref up to date for all consumers that need latest version
   useEffect(() => { animationLoopRef.current = animationLoop; });

   /**
    * Pre-warm: Set ALL sequence layers visible simultaneously in a single batch
    * to force the rendering engine to create texture tiles for all of them.
    * The canvas visually shows the current (top) frame unchanged since all frames
    * occupy the same bounds and overlap. After 2 rAF ticks (ensuring GPU upload),
    * restore the starting frame and begin normal playback.
    */
   const warmAndPlay = useCallback((startIndex: number) => {
      if (!sequenceRef.current || !activeFrame) return;
      const seq = sequenceRef.current;

      setIsWarming(true);

      // Step 1: Make ALL sequence layers visible, but move the current frame's
      // layer to the END of the order array (top of z-stack) so it stays visually
      // on top. This way all other textures get created underneath without any flash.
      const currentLayerId = seq.layers[startIndex].id;
      const warmOrder = [...activeFrame.layers.order];
      const currentOrderIdx = warmOrder.indexOf(currentLayerId);
      if (currentOrderIdx >= 0) {
         warmOrder.splice(currentOrderIdx, 1);
         warmOrder.push(currentLayerId);
      }

      const updatedById: Record<string, Layer> = { ...activeFrame.layers.byId };
      for (let i = 0; i < seq.layers.length; i++) {
         const layer = seq.layers[i];
         updatedById[layer.id] = { ...updatedById[layer.id], visible: true };
      }
      actions.updateFrame(activeFrame.id, {
         layers: { byId: updatedById, order: warmOrder },
      });

      // Step 2: Wait 3 rAF ticks (~48ms) for rendering engine to process all texture tiles
      let tickCount = 0;
      const waitForRender = () => {
         if (!playingRef.current) {
            // Cancelled during warm-up — restore original order and visibility
            showFrame(startIndex);
            actions.updateFrame(activeFrame.id, {
               layers: { ...activeFrame.layers, order: activeFrame.layers.order },
            });
            setIsWarming(false);
            return;
         }
         tickCount++;
         if (tickCount < 3) {
            rafRef.current = requestAnimationFrame(waitForRender);
         } else {
            // Step 3: Warm-up complete — restore original order + starting frame visibility
            warmedRef.current = true;
            setIsWarming(false);

            // Restore original layer order and set only starting frame visible
            const restoredById: Record<string, Layer> = { ...activeFrame.layers.byId };
            for (let i = 0; i < seq.layers.length; i++) {
               const layer = seq.layers[i];
               restoredById[layer.id] = { ...restoredById[layer.id], visible: i === startIndex };
            }
            actions.updateFrame(activeFrame.id, {
               layers: { byId: restoredById, order: activeFrame.layers.order },
            });
            currentIndexRef.current = startIndex;
            setCurrentIndex(startIndex);

            // Begin real playback
            lastFrameTimeRef.current = performance.now();
            rafRef.current = requestAnimationFrame(animationLoopRef.current!);
         }
      };

      rafRef.current = requestAnimationFrame(waitForRender);
   }, [activeFrame, actions, showFrame]);

   const play = useCallback(() => {
      if (!sequence) return;
      playingRef.current = true;
      setIsPlaying(true);

      if (!warmedRef.current) {
         // First play: pre-warm texture caches before starting real playback
         warmAndPlay(currentIndexRef.current);
      } else {
         // Already warmed: start immediately
         lastFrameTimeRef.current = performance.now();
         rafRef.current = requestAnimationFrame(animationLoopRef.current!);
      }
   }, [sequence, warmAndPlay]);

   const pause = useCallback(() => {
      playingRef.current = false;
      setIsPlaying(false);
      if (rafRef.current) {
         cancelAnimationFrame(rafRef.current);
         rafRef.current = null;
      }
   }, []);

   // Pause animation when a modal dialog (confirm or choice) is shown (Solution A)
   const isModalVisible = !!(state.confirm?.isVisible || state.choice?.isVisible);
   useEffect(() => {
      if (isModalVisible && playingRef.current) {
         pause();
      }
   }, [isModalVisible, pause]);

   const stop = useCallback(() => {
      playingRef.current = false;
      setIsPlaying(false);
      if (rafRef.current) {
         cancelAnimationFrame(rafRef.current);
         rafRef.current = null;
      }
      showFrame(0);
   }, [showFrame]);

   const prevFrame = useCallback(() => {
      if (!sequence) return;
      const prevIndex = (currentIndex - 1 + sequence.totalFrames) % sequence.totalFrames;
      showFrame(prevIndex);
   }, [sequence, currentIndex, showFrame]);

   const nextFrame = useCallback(() => {
      if (!sequence) return;
      const nextIndex = (currentIndex + 1) % sequence.totalFrames;
      showFrame(nextIndex);
   }, [sequence, currentIndex, showFrame]);

   const gotoFrame = useCallback((index: number) => {
      showFrame(index);
   }, [showFrame]);

   const toggleLoop = useCallback(() => {
      setSelfConfig({ loop: !selfConfig?.loop });
   }, [selfConfig, setSelfConfig]);

   const recalculateFps = useCallback(() => {
      if (!sequence || sequence.totalFrames === 0) return;
      const delays = sequence.layers.map(l => (l.metadata?.gifFrameDelay as number) || 100);
      const fps = GifHandler.calculateFps(delays);
      setSelfConfig({ frameRateOverride: fps });
   }, [sequence, setSelfConfig]);

   const totalFrames = sequence?.totalFrames || 0;
   const progress = totalFrames > 1 ? (currentIndex / (totalFrames - 1)) * 100 : 0;

   return {
      state: {
         sequence,
         currentIndex,
         isPlaying,
         isWarming,
         loopEnabled: !!selfConfig?.loop,
         totalFrames,
         progress,
      },
      actions: { play, pause, stop, prevFrame, nextFrame, gotoFrame, toggleLoop, recalculateFps },
   };
}

// ═══════════════════════════════════════════════════════════════════════════════
// useAnimationExport: Export control hook
// ═══════════════════════════════════════════════════════════════════════════════

export function useAnimationExport() {
   const [selfConfig, setSelfConfig] = usePluginSelfConfig<AnimationConfig>();
   const { exportAnimationCmd } = usePluginCommands<AnimationDrawerCommandsMap>();

   return useMemo(() => ({
      config: selfConfig,
      updateConfig: setSelfConfig,
      exportAnimationCmd,
   }), [selfConfig, setSelfConfig, exportAnimationCmd]);
}
