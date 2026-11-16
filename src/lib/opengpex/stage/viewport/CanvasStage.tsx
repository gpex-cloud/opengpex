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

import React, { useRef, useLayoutEffect, useEffect, useCallback, useMemo } from 'react';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import { useOverlayRotationSync } from '@opengpex/editor/core/motion/hooks/animation';
import { presets } from '@opengpex/editor/core/helpers/preferences';
import {
  GpuDevice,
  DISPLAY_CHANNEL_SIGNAL_KEY,
} from '@opengpex/editor/core/engine';
import {
  STAGE_OMITTED_LAYERS_SIGNAL_KEY,
  omittedLayers,
} from './CanvasStageFilter';
import { mergeFrameSnapshot } from '@opengpex/editor/core/state/volatile/merge';
import { RenderController } from '@opengpex/editor/core/engine/RenderController';

/**
 * CanvasStage: the React binding shell for the render loop (WebGPU v2 Core).
 *
 * This component owns ONLY what React must own — the canvas element, the
 * session signals that feed the loop (channel mask, active frame, viewport
 * size, services) and the mount/unmount lifecycle. Every engine
 * responsibility (dirty state, cache subscriptions, HDR presentation
 * sequencing, buffer sizing, the per-tick assemble→upload→view→render body)
 * lives in the framework-free {@link RenderController}; this shell merely
 * forwards intents into it.
 */
export default function CanvasStage() {
  const { state, activeFrame } = useEditorState();
  const { geometry, assets, files } = useEditorServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Inject artboard-level CSS rotation sync animation
  useOverlayRotationSync(canvasRef, activeFrame);

  // [Display Transform] Read the 4-bit channel-visibility mask signal (written by
  // the LayersDrawer Channels panel). Absent → normal RGB. Flows into
  // renderTick as a per-tick input — the controller diffs it itself, no
  // out-of-band dirty signaling needed.
  const channelMask = state.interaction.signals[DISPLAY_CHANNEL_SIGNAL_KEY];

  // [Stage content filter] Sessions that present some layers elsewhere (the
  // animation playback overlay) publish the layer ids to omit through the
  // stage's OWN generic signal — the stage knows "skip these layers", never
  // WHY (no playback/sequence vocabulary crosses this boundary). Memoized
  // frame copy: the stable reference keeps the render caches warm (one
  // rebuild on publish, none per playback frame). Document state is never
  // written; clearing the signal restores the full frame.
  const omittedLayerIds = state.interaction.signals[STAGE_OMITTED_LAYERS_SIGNAL_KEY] as readonly string[] | null;
  const filteredFrame = useMemo(
    () => omittedLayers(activeFrame, omittedLayerIds),
    [activeFrame, omittedLayerIds],
  );

  // ─── [Per-document HDR presentation switch] ───
  // `frame.hdrRender === true` selects the SURFACE mode (SDR: bgra8unorm +
  // white clamp; HDR: rgba16float + extended + unclamped-tail view variant).
  // The controller owns the settled mode end-to-end (surface reconfigure is
  // applied by the controller itself at the sequenced moment) — the stage
  // only forwards the REQUEST.
  const hdrRequested = activeFrame ? activeFrame.hdrRender === true : false;

  // The controller outlives every render: its dirty flag, cache subscriptions
  // and HDR sequencing must NOT be reset by a re-render. Created lazily on
  // first use (all its inputs are module singletons), disposed on unmount —
  // StrictMode's mount→cleanup→mount cycle therefore gets a fresh controller
  // with fresh subscriptions.
  const controllerRef = useRef<RenderController | null>(null);
  // Empty dependency array: the constructor takes no arguments, so the lazy
  // factory has no reactive inputs at all.
  const getController = useCallback(() => {
    if (!controllerRef.current) {
      controllerRef.current = new RenderController();
    }
    return controllerRef.current;
  }, []);
  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, []);

  // Forward the HDR request; the controller sequences dim → settled mode.
  useLayoutEffect(() => {
    getController().setHdrRequested(hdrRequested, activeFrame?.id);
  }, [getController, hdrRequested, activeFrame?.id]);

  // ─── WebGPU Canvas Mount & Surface Configuration ───
  // The swapchain gamut is NOT passed: it is a hard invariant (WORKING_GAMUT,
  // hardcoded in `GpuDevice.configureSurface`). HDR presentation-mode flips
  // never come through here — the controller reconfigures the surface
  // directly at the sequenced moment (dim settle / frame change).
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !GpuDevice.isSupported()) return;
    // Synchronously bind new or remounted canvas in layout phase before
    // fastSync ticker fires. Engine readiness is the CONTROLLER's concern —
    // attachCanvas no-ops on a cold engine (initCanvas below boots it).
    getController().attachCanvas(canvas);
  }, [getController]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !GpuDevice.isSupported()) return;

    let cancelled = false;
    const controller = getController();
    void controller
      .initCanvas(canvas)
      .then((caps) => {
        if (cancelled) return;
        if (PERF_MON) {
          console.info('[CanvasStage] WebGPU engine mounted to canvas:', caps);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('[CanvasStage] WebGPU init failed on stage canvas:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [getController]);

  // [Performance] Unified sync pipeline ticker (60fps): the tick body lives in
  // the controller; this shell only feeds it the session-side inputs.
  useFastSync(canvasRef, true, (v, f, cam) => {
    const canvas = canvasRef.current;
    if (!canvas || !f || !cam) return;
    // During a playback session the stage renders the SILENCED frame (its
    // layers re-merged with the fast-sync draft so live gestures on remaining
    // layers still preview); otherwise the merged frame verbatim.
    const renderedFrame =
      omittedLayerIds && filteredFrame
        ? mergeFrameSnapshot(v, filteredFrame).frame
        : f;
    getController().renderTick({
      canvas,
      frame: renderedFrame,
      camera: cam,
      viewportDim: state.ui.viewportDim,
      dpr: window.devicePixelRatio || 1,
      channelMask,
      // Fixed composite density (zoom-free), read synchronously — O(1).
      adaptiveDensity: presets.get('COMPOSITE_ADAPTIVE_DENSITY') !== false,
      volatile: v,
      geometry,
      assets,
      files,
    });
  });

  if (!activeFrame) return null;

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 left-0 bg-transparent"
      style={{ display: 'block' }}
    />
  );
}
