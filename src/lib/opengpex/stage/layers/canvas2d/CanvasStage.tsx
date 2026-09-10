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

import React, { useRef, useEffect, useLayoutEffect } from 'react';
import type { Frame, CameraState } from '@opengpex/editor/core/types';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import { useOverlayRotationSync } from '@opengpex/editor/core/motion/hooks/animation';
import { sourceBitmapCache, tileCache, getGpuEngine } from '@opengpex/editor/core/engine/renderer';
import { GpuDevice } from '@opengpex/editor/core/gpu/device/GpuDevice';
import { SceneAssembler } from '@opengpex/editor/core/gpu/scene/SceneAssembler';
import { SceneContentCache } from '@opengpex/editor/core/gpu/scene/SceneContentCache';
import type { ChannelMaskMode } from '@opengpex/editor/core/gpu/shaders/layer';
import { DISPLAY_CHANNEL_SIGNAL_KEY, type ChannelMask } from '@opengpex/editor/core/engine/protocol/DisplayTransform';

import { useLayerTweens } from './useLayerTweens';

/**
 * CanvasStage: Industrial-grade high-performance rendering stage (WebGPU v2 Core)
 */
export default function CanvasStage() {
  const { state, activeFrame } = useEditorState();
  const { geometry, assets } = useEditorServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 1. Animation state management (Encapsulated)
  const { getAnimatedRotation, isAnimating } = useLayerTweens(activeFrame);

  // Inject artboard-level CSS rotation sync animation
  useOverlayRotationSync(canvasRef, activeFrame);

  // [Display Transform] Read channel mask signal ('rgb' | 'r' | 'g' | 'b' | 'a')
  const channelMask = (state.interaction.signals[DISPLAY_CHANNEL_SIGNAL_KEY] as ChannelMask) || 'rgb';

  /**
   * renderLoop: Core synchronized rendering logic
   */
  const needsRenderRef = useRef(true); // Default to first render
  const _renderCountRef = useRef(0); // Cold-start counter for perf warning suppression

  // ─── [PERF_MON] P1 diagnostics: split assemble vs render + frame cadence ───
  // Only allocated/used when PERF_MON is on; zero cost otherwise. These let a
  // real-machine capture answer the P1 question ("is the 120→100 dip in the CPU
  // assemble or in the GPU render?") and see the inter-frame cadence jitter
  // ("无规律波动") that a single-frame threshold gate cannot.
  const _lastTickTsRef = useRef(0); // previous tick timestamp (for inter-frame gap)
  const _perfWindowRef = useRef<{
    n: number;
    assembleSum: number;
    assembleMax: number;
    renderSum: number;
    renderMax: number;
    gapSum: number;
    gapMax: number;
    over83: number; // frames exceeding the 120Hz budget (~8.3ms end-to-end)
    lastFlush: number;
  }>({ n: 0, assembleSum: 0, assembleMax: 0, renderSum: 0, renderMax: 0, gapSum: 0, gapMax: 0, over83: 0, lastFlush: 0 });

  const gpuEngine = getGpuEngine();
  const isGpuReadyRef = useRef(false);

  // ─── WebGPU Canvas Mount & Surface Configuration (§4.3, §13.3) ───
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !GpuDevice.isSupported()) return;

    const colorSpace = activeFrame?.colorSpace ?? 'srgb';

    // Synchronously bind new or remounted canvas in layout phase before fastSync ticker fires
    if (gpuEngine.isReady()) {
      gpuEngine.attachCanvas(canvas, { colorSpace, hdr: false });
      isGpuReadyRef.current = true;
      needsRenderRef.current = true;
    }
  }, [gpuEngine, activeFrame?.id, activeFrame?.colorSpace]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !GpuDevice.isSupported()) return;

    let cancelled = false;
    const colorSpace = activeFrame?.colorSpace ?? 'srgb';

    void gpuEngine
      .init(canvas, {
        colorSpace,
        hdr: false,
      })
      .then((caps) => {
        if (cancelled) return;
        isGpuReadyRef.current = true;
        needsRenderRef.current = true;
        console.info('[CanvasStage] WebGPU engine mounted to canvas:', caps);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('[CanvasStage] WebGPU init failed on stage canvas:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [gpuEngine, activeFrame?.id, activeFrame?.colorSpace]);

  // [Display Transform] Mark dirty when channel mask changes.
  const channelMaskRef = useRef(channelMask);
  useLayoutEffect(() => {
    if (channelMaskRef.current !== channelMask) {
      channelMaskRef.current = channelMask;
      needsRenderRef.current = true;
      _renderCountRef.current = 0; // suppress perf warning for warmup frames
    }
  }, [channelMask]);

  // 2. Subscribe to cache changes; mark redraw needed once slices or full images load
  useEffect(() => {
    const unsubTiles = tileCache.subscribe(() => {
      needsRenderRef.current = true;
    });
    const unsubImages = sourceBitmapCache.subscribe(() => {
      needsRenderRef.current = true;
    });

    return () => {
      unsubTiles();
      unsubImages();
    };
  }, []);

  // 3. State synchronization: trigger redraw when active frame changes
  useLayoutEffect(() => {
    needsRenderRef.current = true;
  }, [activeFrame]);

  const lastFrameRef = useRef<Frame | null>(null);
  const lastCamRef = useRef<CameraState | null>(null);

  // [P1 §4] CPU-side compose-once/view-many: memoize the camera-independent
  // content half so pan/zoom frames skip the O(layers) re-assembly and run only
  // the cheap view fold. See SceneContentCache for the never-false-clean proof.
  const contentCacheRef = useRef<SceneContentCache>(new SceneContentCache());

  // [Performance Optimization] Integrates with unified sync pipeline (60fps Ticker)
  useFastSync(canvasRef, true, (v, f, cam) => {
    const canvas = canvasRef.current;
    if (!canvas || !f || !cam) return;

    // Physical viewport synchronization and Retina high-DPI adaptation
    const { w, h } = state.ui.viewportDim;
    const dpr = window.devicePixelRatio || 1;
    let bufferResized = false;

    if (w > 0 && h > 0) {
      // Sync CSS display size
      if (canvas.style.width !== `${w}px`) canvas.style.width = `${w}px`;
      if (canvas.style.height !== `${h}px`) canvas.style.height = `${h}px`;

      // Sync buffer pixel dimensions (HiDPI)
      const targetW = Math.floor(w * dpr);
      const targetH = Math.floor(h * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        bufferResized = true; // Buffer resize clears canvas — must repaint
      }
    }

    const isDirty = needsRenderRef.current || bufferResized;

    // Skip render if scene is completely static
    if (
      !isDirty &&
      !isAnimating &&
      f === lastFrameRef.current &&
      cam === lastCamRef.current
    ) {
      return;
    }

    if (!gpuEngine.isReady()) {
      return;
    }

    const isInteracting = v.activeState.interacting;
    let _frameT0 = 0;
    let _assembleT0 = 0;
    if (PERF_MON) {
      _frameT0 = performance.now();
    }

    // Update snapshot
    lastFrameRef.current = f;
    lastCamRef.current = cam;
    needsRenderRef.current = false;

    if (PERF_MON) {
      _assembleT0 = performance.now();
    }

    // Assemble immutable Scene descriptor from state + volatile fast-track (§5.4)
    //
    // [P1 §4] CPU compose-once/view-many: the camera-INDEPENDENT content half
    // (layers/masks/uploads) is memoized on a reference-identity key; only the
    // cheap view fold (`composeView`) runs every frame. On a cam-only frame the
    // key is unchanged → same content object → the O(layers) loop is skipped.
    // `dirty` (needsRender/bufferResize) and `isAnimating` force a rebuild, and
    // any genuine edit yields a new `f.layers` reference (see SceneContentCache).
    //
    // ⚠️ REAL-MACHINE FINDING (2026-09, §4): the "pan/zoom 120→100" that prompted
    // P1 was a DevTools measurement artifact — with F12 closed the pipeline holds
    // ~120 (min 116) and PERF_MON reports assemble≈0.01ms / render≈0.07ms. This
    // memo is therefore a defence-in-depth win for heavy (many-layer / masked)
    // scenes, NOT a fix for a per-frame CPU defect on the common 2-layer case.
    const { content, uploads } = contentCacheRef.current.get(
      {
        layersRef: f.layers,
        canvasW: f.canvas.w,
        canvasH: f.canvas.h,
        colorSpace: f.colorSpace,
        dirty: isDirty,
        animating: isAnimating,
      },
      () =>
        SceneAssembler.buildContent({
          frame: f,
          geometry,
          assets,
          getAnimatedRotation,
          getImageOverride: (layerId: string) => {
            const compositeKey = `${f.id}:${layerId}`;
            const draft = v.buffered.layers[compositeKey];
            return draft?.imageOverride || undefined;
          },
          getBitmapMaskOverride: (layerId: string) => {
            const compositeKey = `${f.id}:${layerId}`;
            const draft = v.buffered.layers[compositeKey];
            return draft?.bitmapMaskOverride || undefined;
          },
        }),
    );

    // Flush the (possibly empty on a cache hit) upload plan into the engine.
    SceneAssembler.syncAssets(uploads, gpuEngine);

    // Fold the camera-dependent view onto the content to get the final Scene.
    const scene = SceneAssembler.composeView(content, {
      frame: f,
      camera: cam,
      viewportDim: state.ui.viewportDim,
      dpr,
      geometry,
      channelMask: channelMask as ChannelMaskMode,
    });

    let _renderT0 = 0;
    if (PERF_MON) {
      _renderT0 = performance.now();
    }

    // Render directly to WebGPU Swapchain
    gpuEngine.render(scene);

    if (PERF_MON) {
      const _now = performance.now();
      const _assembleDuration = _renderT0 - _assembleT0; // CPU scene assembly
      const _renderDuration = _now - _renderT0; // engine.render (compose?/present)
      const _frameDuration = _now - _frameT0; // end-to-end work this tick
      const _gap = _lastTickTsRef.current > 0 ? _frameT0 - _lastTickTsRef.current : 0;
      _lastTickTsRef.current = _now;
      _renderCountRef.current++;

      // Accumulate a rolling window and flush a summary ~1×/sec so the console
      // shows the AVERAGE/MAX split + cadence jitter rather than noisy per-frame
      // spikes. The 120Hz budget is ~8.3ms end-to-end; count frames over it.
      const win = _perfWindowRef.current;
      if (win.lastFlush === 0) win.lastFlush = _now;
      if (_renderCountRef.current > 3) {
        win.n++;
        win.assembleSum += _assembleDuration;
        win.renderSum += _renderDuration;
        win.gapSum += _gap;
        if (_assembleDuration > win.assembleMax) win.assembleMax = _assembleDuration;
        if (_renderDuration > win.renderMax) win.renderMax = _renderDuration;
        if (_gap > win.gapMax) win.gapMax = _gap;
        if (_frameDuration > 8.3) win.over83++;
      }

      if (win.n > 0 && _now - win.lastFlush >= 1000) {
        console.warn(
          `[CanvasStage.WebGPU] window(${win.n}f) ` +
            `assemble avg=${(win.assembleSum / win.n).toFixed(2)}ms max=${win.assembleMax.toFixed(2)}ms | ` +
            `render avg=${(win.renderSum / win.n).toFixed(2)}ms max=${win.renderMax.toFixed(2)}ms | ` +
            `gap avg=${(win.gapSum / win.n).toFixed(2)}ms max=${win.gapMax.toFixed(2)}ms | ` +
            `over8.3ms=${win.over83}/${win.n} layers=${scene.layers.length} interacting=${isInteracting}`,
        );
        win.n = 0;
        win.assembleSum = 0;
        win.assembleMax = 0;
        win.renderSum = 0;
        win.renderMax = 0;
        win.gapSum = 0;
        win.gapMax = 0;
        win.over83 = 0;
        win.lastFlush = _now;
      }
    }
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
