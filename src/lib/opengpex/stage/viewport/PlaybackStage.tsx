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

"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { useEditorState, useEditorServices } from "@opengpex/editor/core/context";
import { useFastSync } from "@opengpex/editor/core/state/volatile";
import { useOverlayRotationSync } from "@opengpex/editor/core/motion/hooks/animation";
import { imageBitmapCache, GpuDevice } from "@opengpex/editor/core/engine";
import { PlaybackController } from "@opengpex/editor/core/engine/playback/PlaybackController";
import {
  PLAYBACK_SESSION_SIGNAL_KEY,
  PLAYBACK_SEEK_SIGNAL_KEY,
  type PlaybackSeekRequest,
  type PlaybackSessionSpec,
} from "@opengpex/editor/core/engine/playback/protocol";

/**
 * PlaybackStage — the host of the playback pipeline's second canvas.
 *
 * Mounted once in the viewport as CanvasStage's SIBLING FILE (stage/viewport/
 * PlaybackStage.tsx beside stage/viewport/CanvasStage.tsx — same directory,
 * mirrored lifecycle), above the stage content, below the stage overlays. When the plugin publishes a playback
 * session signal the surface mounts its canvas, builds a PlaybackController
 * over the engine's shared GPUDevice and drives it from the viewport ticker.
 * On signal clear (pause/stop) the controller is disposed and the canvas
 * unmounts — a playback session's lifetime IS the signal's lifetime.
 *
 * The plugin side never touches WebGPU: it publishes the session spec (frame
 * table, loop, callbacks) through the signal and receives seek via the
 * spec's `commands` bridge + frame feedback via `onFrameChange`.
 */
export function PlaybackStage() {
  const { state } = useEditorState();
  const { geometry, assets } = useEditorServices();

  const session = state.interaction.signals[PLAYBACK_SESSION_SIGNAL_KEY] as PlaybackSessionSpec | null;
  const activeFrame = state.activeFrameId ? state.frames.byId[state.activeFrameId] : null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<PlaybackController | null>(null);
  // Latest session in a ref: the tick callback reads it without tearing down
  // the useFastSync subscription on every onFrameChange re-render.
  const sessionRef = useRef<PlaybackSessionSpec | null>(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Artboard ±90° rotation is a DOM-transform compensation on the stage
  // canvas — the playback canvas must carry the identical compensation to
  // stay pixel-aligned with the stage's static composite.
  useOverlayRotationSync(canvasRef, activeFrame);

  // Seek requests (plugin → pipeline): consume the signal and move the
  // playhead. Keyed on the whole request (rev included) so repeated seeks to
  // the same index re-trigger.
  const seekRequest = state.interaction.signals[PLAYBACK_SEEK_SIGNAL_KEY] as PlaybackSeekRequest | null;
  useEffect(() => {
    const controller = controllerRef.current;
    const spec = sessionRef.current;
    if (!controller || !spec || !seekRequest) return;
    if (seekRequest.sequenceId !== spec.sequenceId) return;
    controller.seek(seekRequest.index);
  }, [seekRequest]);

  // Session lifecycle → controller lifecycle. `assets`/`geometry` are stable
  // store services (reference-stability guarantee), safe to omit from deps:
  // the effect is keyed on the session descriptor alone.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session || !GpuDevice.isSupported()) return;
    const controller = new PlaybackController({
      canvas,
      session,
      resolveSrc: (assetId, src) => assets.resolve(assetId, src) ?? src,
      getBitmapSource: (src) => imageBitmapCache.getOrFetch(src),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on session; services are stable singletons
  }, [session]);

  // One clock for the whole editor: the viewport ticker drives the controller
  // (no second rAF). The camera comes pre-merged by the fast-sync snapshot;
  // frame placement is resolved through the injected geometry seam.
  useFastSync(canvasRef, true, (_v, f, cam) => {
    const controller = controllerRef.current;
    const spec = sessionRef.current;
    if (!controller || !spec) return;
    controller.tick({
      camera: cam,
      frame: f,
      viewportDim: state.ui.viewportDim,
      dpr: window.devicePixelRatio || 1,
      getLayerLocalMatrix: (layer, frame) => geometry.transform.getLayerLocalMatrix(layer, frame),
    });
  });

  if (!session || !GpuDevice.isSupported() || !activeFrame) return null;

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 left-0"
      style={{ display: "block" }}
    />
  );
}
