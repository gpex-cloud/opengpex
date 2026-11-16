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
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { useEditorState, useEditorServices, usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import { Layer } from '@opengpex/editor/core/types';
import { GifHandler } from '@opengpex/editor/core/files/handlers/gif';
import {
  PLAYBACK_SESSION_SIGNAL_KEY,
  PLAYBACK_SEEK_SIGNAL_KEY,
  type PlaybackSessionSpec,
} from '@opengpex/editor/core/engine/playback';
import { STAGE_OMITTED_LAYERS_SIGNAL_KEY } from '@opengpex/editor/stage/viewport/CanvasStageFilter';
import { detectAnimatedImageSequences, frameDelayOf, type AnimatedImageSequence } from './sequence';
import type { AnimatedImagesDrawerCommandsMap } from './commands.d';
import type { AnimatedImagesConfig } from './protocols';

// ═══════════════════════════════════════════════════════════════════════════════
// useAnimatedImagesPlayer — THIN UI CONTROLLER over the engine playback
// pipeline (core/engine/playback/).
//
// 2026-11-16 architecture: this hook owns NO playback machinery — no rAF
// loop, no per-frame document writes, no warm-up dance. Playback runs in the
// engine's presentation pipeline; the hook's entire job is:
//   1. publish a PlaybackSessionSpec (frame table from layer metadata) on
//      play, clear it on pause/stop;
//   2. land ONE document commit per session (the frame the playhead stops
//      on) — the document-write budget of a whole playback session;
//   3. seek double-channel: playhead via the pipeline (cheap), layer
//      selection via setActiveLayer (user intent only — automatic ticks
//      NEVER touch selection).
// ═══════════════════════════════════════════════════════════════════════════════

export interface AnimatedImagesPlayerState {
   sequence: AnimatedImageSequence | null;
   currentIndex: number;
   isPlaying: boolean;
   isWarming: boolean; // decode-ahead pre-roll (loading spinner)
   loopEnabled: boolean;
   totalFrames: number;
   progress: number; // 0-100
}

export interface AnimatedImagesPlayerActions {
   play: () => void;
   pause: () => void;
   stop: () => void;
   prevFrame: () => void;
   nextFrame: () => void;
   gotoFrame: (index: number) => void;
   /**
    * SEEK (user intent): moves the playhead AND selects the target frame's
    * layer (LayersDrawer highlight). `opts.select: false` skips the selection
    * write — used by scrub drags that select once on pointer-up.
    */
   seekTo: (index: number, opts?: { select?: boolean }) => void;
   toggleLoop: () => void;
   recalculateFps: () => void;
}

export function useAnimatedImagesPlayer(): {
   state: AnimatedImagesPlayerState;
   actions: AnimatedImagesPlayerActions;
} {
   const { activeFrame, state } = useEditorState();
   const { actions } = useEditorServices();
   const [selfConfig, setSelfConfig] = usePluginSelfConfig<AnimatedImagesConfig>();

   const [isPlaying, setIsPlaying] = useState(false);
   const [isWarming, setIsWarming] = useState(false);
   const [currentIndex, setCurrentIndex] = useState(0);

   const playingRef = useRef(false);
   const currentIndexRef = useRef(0);
   const sequenceRef = useRef<AnimatedImageSequence | null>(null);
   const configRef = useRef<AnimatedImagesConfig>(selfConfig);
   // Seek-request revision counter (see PLAYBACK_SEEK_SIGNAL_KEY).
   const seekRevRef = useRef(0);

   // Keep config ref up to date (via effect to avoid ref access during render)
   useEffect(() => { configRef.current = selfConfig; });

   // Detect animation sequence
   const sequence = useMemo(() => {
      if (!activeFrame) return null;
      const sequences = detectAnimatedImageSequences(activeFrame);
      return sequences.length > 0 ? sequences[0] : null;
   }, [activeFrame]);

   // Keep sequence ref up to date (via effect to avoid ref access during render)
   useEffect(() => { sequenceRef.current = sequence; });

   /** Per-frame delay table: user FPS override wins, else per-frame metadata. */
   const frameDelays = useCallback((seq: AnimatedImageSequence): number[] => {
      const fpsOverride = configRef.current?.frameRateOverride;
      if (fpsOverride && fpsOverride > 0) {
         const uniform = 1000 / fpsOverride;
         return seq.layers.map(() => uniform);
      }
      return seq.layers.map(frameDelayOf);
   }, []);

   /* eslint-disable react-hooks/refs */
   // Synchronously terminate playback if sequenceId changes during render phase
   const prevSequenceIdRef = useRef<string | null>(null);
   if (prevSequenceIdRef.current !== sequence?.sequenceId) {
      prevSequenceIdRef.current = sequence?.sequenceId || null;
      playingRef.current = false;
   }
   /* eslint-enable react-hooks/refs */

   /** Clear both session signals (pause/stop/sequence-change/unmount). */
   const clearSession = useCallback(() => {
      actions.setStateSignal(PLAYBACK_SESSION_SIGNAL_KEY, null);
      actions.setStateSignal(STAGE_OMITTED_LAYERS_SIGNAL_KEY, null);
   }, [actions]);

   // Reset playback state when sequence changes (e.g., user switches to another
   // frame and back). The session signals are orphans by definition — the doc
   // was never mutated during playback, so dropping them restores the
   // committed document view verbatim.
   useEffect(() => {
      playingRef.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional state reset on sequence change
      setIsPlaying(false);
      setIsWarming(false);
      clearSession();

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
      const fps = GifHandler.calculateFps(sequence.layers.map(frameDelayOf));
      setSelfConfig({ frameRateOverride: fps });
   // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on sequenceId + totalFrames, not full objects
   }, [sequence?.sequenceId, sequence?.totalFrames]);

   // Cleanup on unmount: a session must never outlive its owner.
   useEffect(() => {
      return () => {
         playingRef.current = false;
         clearSession();
      };
   }, [clearSession]);

   /**
    * COMMIT — the ONLY document write in the playback system: land `index`
    * as the sequence's committed visibility (single atomic updateFrame).
    * At most once per pause / stop / paused-seek — never per animation tick.
    */
   const commitFrame = useCallback((index: number) => {
      if (!activeFrame || !sequenceRef.current) return;
      const seq = sequenceRef.current;
      if (index < 0 || index >= seq.totalFrames) return;

      const updatedById: Record<string, Layer> = { ...activeFrame.layers.byId };
      for (let i = 0; i < seq.layers.length; i++) {
         const layer = seq.layers[i];
         updatedById[layer.id] = { ...updatedById[layer.id], visible: i === index };
      }

      actions.updateFrame(activeFrame.id, {
         layers: { byId: updatedById, order: activeFrame.layers.order },
      });

      currentIndexRef.current = index;
      setCurrentIndex(index);
   }, [activeFrame, actions]);

   const play = useCallback(() => {
      const seq = sequenceRef.current;
      if (!seq || !activeFrame) return;
      playingRef.current = true;
      setIsPlaying(true);
      setIsWarming(true);

      // Publish the session. The spec snapshots the frame table (already
      // carrying the FPS override) — the pipeline never reads the document
      // again while playing. `commands` is the plugin↔controller bridge
      // (controller installs seek on start); onFrameChange feeds the UI.
      const delays = frameDelays(seq);
      const spec: PlaybackSessionSpec = {
         sequenceId: seq.sequenceId,
         loop: !!configRef.current?.loop,
         startIndex: currentIndexRef.current,
         frames: seq.layers.map((layer, i) => ({
            layerId: layer.id,
            assetId: layer.assetId,
            src: layer.src,
            delay: delays[i],
         })),
         onFrameChange: (index: number) => {
            currentIndexRef.current = index;
            setCurrentIndex(index);
            setIsWarming(false); // first presented frame ends the pre-roll
         },
         onEnded: () => {
            // Non-loop session finished (or device lost): the pipeline drops
            // its presentation; the plugin ends the session document-side.
            playingRef.current = false;
            setIsPlaying(false);
            setIsWarming(false);
            clearSession();
            commitFrame(0);
         },
      };

      actions.setStateSignal(PLAYBACK_SESSION_SIGNAL_KEY, spec);
      // Stage silence: the sequence's layer ids leave the stage frame while
      // the overlay presents them (alpha frames would double-composite).
      actions.setStateSignal(STAGE_OMITTED_LAYERS_SIGNAL_KEY, seq.layers.map(l => l.id));
   }, [activeFrame, actions, clearSession, commitFrame, frameDelays]);

   const pause = useCallback(() => {
      if (!playingRef.current) return;
      playingRef.current = false;
      setIsPlaying(false);
      setIsWarming(false);
      clearSession();
      // Freeze the playhead into the document — the single commit of a
      // playback session (the transient never mutated the document) — and
      // select the stopped frame's layer so the LayersDrawer reveals it.
      const stopped = currentIndexRef.current;
      commitFrame(stopped);
      if (activeFrame) {
         const layer = sequenceRef.current?.layers[stopped];
         if (layer) actions.setActiveLayer(activeFrame.id, layer.id);
      }
   }, [activeFrame, actions, clearSession, commitFrame]);

   // Pause animation when a modal dialog (confirm or choice) is shown
   const isModalVisible = !!(state.confirm?.isVisible || state.choice?.isVisible);
   useEffect(() => {
      if (isModalVisible && playingRef.current) {
         pause();
      }
   }, [isModalVisible, pause]);

   const stop = useCallback(() => {
      playingRef.current = false;
      setIsPlaying(false);
      setIsWarming(false);
      clearSession();
      commitFrame(0);
   }, [clearSession, commitFrame]);

   /**
    * SEEK (user intent — two-channel design): the playhead goes through the
    * cheap channel for the current mode (pipeline command while playing, one
    * document commit while paused); the SELECTION write runs only here —
    * user-initiated seeks select the target frame's layer so the
    * LayersDrawer highlights it. The automatic animation tick NEVER touches
    * selection.
    */
   const seekTo = useCallback((index: number, opts?: { select?: boolean }) => {
      if (!activeFrame || !sequenceRef.current) return;
      const seq = sequenceRef.current;
      const clamped = Math.max(0, Math.min(seq.totalFrames - 1, index));

      if (playingRef.current) {
         // Playhead channel: publish a seek request the playback surface
         // consumes on its next effect pass (the pipeline's clock jumps).
         seekRevRef.current += 1;
         actions.setStateSignal(PLAYBACK_SEEK_SIGNAL_KEY, {
            sequenceId: seq.sequenceId,
            index: clamped,
            rev: seekRevRef.current,
         });
      } else {
         commitFrame(clamped);
      }
      if (opts?.select !== false) {
         const targetLayer = seq.layers[clamped];
         if (targetLayer) actions.setActiveLayer(activeFrame.id, targetLayer.id);
      }
   }, [activeFrame, actions, commitFrame]);

   const prevFrame = useCallback(() => {
      if (!sequenceRef.current) return;
      seekTo((currentIndexRef.current - 1 + sequenceRef.current.totalFrames) % sequenceRef.current.totalFrames);
   }, [seekTo]);

   const nextFrame = useCallback(() => {
      if (!sequenceRef.current) return;
      seekTo((currentIndexRef.current + 1) % sequenceRef.current.totalFrames);
   }, [seekTo]);

   const gotoFrame = useCallback((index: number) => {
      seekTo(index);
   }, [seekTo]);

   const toggleLoop = useCallback(() => {
      setSelfConfig({ loop: !selfConfig?.loop });
   }, [selfConfig, setSelfConfig]);

   const recalculateFps = useCallback(() => {
      if (!sequence || sequence.totalFrames === 0) return;
      const fps = GifHandler.calculateFps(sequence.layers.map(frameDelayOf));
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
      actions: { play, pause, stop, prevFrame, nextFrame, gotoFrame, seekTo, toggleLoop, recalculateFps },
   };
}

// ═══════════════════════════════════════════════════════════════════════════════
// useAnimatedImagesExport: Export control hook
// ═══════════════════════════════════════════════════════════════════════════════

export function useAnimatedImagesExport() {
   const [selfConfig, setSelfConfig] = usePluginSelfConfig<AnimatedImagesConfig>();
   const { exportAnimatedImageCmd } = usePluginCommands<AnimatedImagesDrawerCommandsMap>();

   return useMemo(() => ({
      config: selfConfig,
      updateConfig: setSelfConfig,
      exportAnimatedImageCmd,
   }), [selfConfig, setSelfConfig, exportAnimatedImageCmd]);
}
