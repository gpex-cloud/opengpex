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
import { Frame, CameraState } from '@opengpex/editor/core/types';
import { convertImageDataColorSpace, displaySupportsP3 } from '@opengpex/editor/core/color/matrices';
import { resolveDisplayColorSpace } from '@opengpex/editor/core/color/ColorPipeline';
import { FontService } from '@opengpex/editor/core/fonts';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { useOverlayRotationSync } from '@opengpex/editor/core/motion/hooks/animation';
import { sourceBitmapCache, tileCache, filterCache, getEngine } from '@opengpex/editor/core/engine/renderer';
import { DISPLAY_CHANNEL_SIGNAL_KEY, type ChannelMask } from '@opengpex/editor/core/engine/protocol/DisplayTransform';
// [Filter Pipeline §3.5 hard invariant] AsyncFilterCache is imported ONLY from
// main-thread modules (this file + Canvas2dEngine.ts). painter.ts and any
// worker/** module MUST NOT import it — that would drag WorkerBridge (which
// spins up new Worker(...) at module top-level) into the engine worker's own
// module graph, causing Turbopack to fan out ~30 helper `turbopack-worker-*`
// VMs and crash the landing page (see 2026-07-09 retrospective in spec §3.5.2).



import { useLayerTweens } from './useLayerTweens';
import { stageComposer } from './StageComposer';


/**
 * CanvasStage: Industrial-grade high-performance rendering engine (60FPS+ smooth optimized version)
 */
export default function CanvasStage() {
  const { state, activeFrame } = useEditorState();
  const { geometry, assets, fonts } = useEditorServices();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 1. Animation state management (Encapsulated)
  const { getAnimatedRotation, isAnimating } = useLayerTweens(activeFrame);
  
  // [Phase 4 Fix] Inject artboard-level CSS rotation sync animation
  useOverlayRotationSync(canvasRef, activeFrame);

  // [Display Transform] Read channel mask signal
  const channelMask = (state.interaction.signals[DISPLAY_CHANNEL_SIGNAL_KEY] as ChannelMask) || 'rgb';

  /**
   * renderLoop: Core synchronized rendering logic
   */
  const needsRenderRef = useRef(true); // Default to first render
  const _renderCountRef = useRef(0); // Cold-start counter for perf warning suppression

  // [Display Transform] Inject SVG filter definitions on mount (one-time)
  useEffect(() => {
    ensureChannelFiltersSVG();
  }, []);

  // [Display Transform] Mark dirty when channel mask changes.
  // Reset render counter to suppress perf warnings during the 1-2 frames of
  // GPU pipeline reconfiguration (intermediate canvas allocation + filter warmup).
  const channelMaskRef = useRef(channelMask);
  useLayoutEffect(() => {
    if (channelMaskRef.current !== channelMask) {
      channelMaskRef.current = channelMask;
      needsRenderRef.current = true;
      _renderCountRef.current = 0; // suppress perf warning for warmup frames
    }
  }, [channelMask]);

  // [Font Loading] Inject FontService into engine with redraw callback
  const engine = getEngine();
  useEffect(() => {
    if ('setFontService' in engine) {
      (engine as { setFontService: (fonts: FontService, cb: () => void) => void }).setFontService(fonts, () => {
        needsRenderRef.current = true;
      });
    }
  }, [fonts, engine]);

  // 1. Subscribe to cache changes; mark redraw needed once slices or full images load
  useEffect(() => {
    const unsubTiles = tileCache.subscribe(() => {
      needsRenderRef.current = true;
    });
    // [SourceBitmapCache refactor 2026-07-10] Redraws are now triggered when a
    // shared ImageBitmap lands (fetch → blob → createImageBitmap completes).
    // The consumer set (Canvas2dEngine, BrushOverlay, ClipTool wand, …) is
    // exactly the same as before; only the storage type changed from
    // HTMLImageElement to ImageBitmap. See
    // docs/opengpex/plans/20260710_source_bitmap_cache_refactor_plan.md.
    const unsubImages = sourceBitmapCache.subscribe(() => {
      needsRenderRef.current = true;
    });
    // [Filter Pipeline §5.2 / Step 3] Redraw when a filtered bitmap lands.
    // Canvas2dEngine.drawLayerDirect schedules async APPLY_FILTER jobs on
    // cache miss and degrades to the raw source for the current frame.
    // Subscribing here ensures the next frame picks up the filtered result.
    const unsubFilters = filterCache.subscribe(() => {
      needsRenderRef.current = true;
    });
    // [Filter Fast-Track §2.3] TileFilterCache removed — tiles now show raw
    // during interaction and AsyncFilterCache handles post-interaction filter.

    return () => {
      unsubTiles();
      unsubImages();
      unsubFilters();
    };

  }, []);


  // 2. State synchronization: trigger redraw when layer properties (e.g. visible) or artboard state change
  useLayoutEffect(() => {
    needsRenderRef.current = true;
  }, [activeFrame]);

  const lastFrameRef = useRef<Frame | null>(null);
  const lastCamRef = useRef<CameraState | null>(null);

  // [Performance Optimization] Integrates with unified sync pipeline, ensuring Canvas pixel drawing and Gizmo borders are absolutely atomically synchronized geometrically
  useFastSync(canvasRef, true, (v, f, cam) => {
    const canvas = canvasRef.current;
    if (!canvas || !f || !cam) return;

    // [Phase 3] Physical viewport synchronization and Retina high-DPI adaptation
    // [Critical Fix] CSS dimensions and buffer dimensions MUST update atomically
    // in the same rAF tick — and BEFORE the skip-render gate below.
    // Previously, CSS was set via React state (immediate on re-render) while
    // buffer resized here in rAF — causing 1-frame stretch on window resize
    // because CSS size changes before buffer catches up.
    // This block must run unconditionally so viewport resizes are never delayed.
    const { w, h } = state.ui.viewportDim;
    const dpr = window.devicePixelRatio || 1;
    let bufferResized = false;
    
    if (w > 0 && h > 0) {
      // Sync CSS display size (imperative, bypasses React for atomic timing)
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
    
    // [Smart Admission Determination]
    // If all of the following conditions are met, the screen is considered static, skip render:
    // 1. Core geometric states (f, cam) are completely consistent with previous frame
    // 2. No manually marked dirty redraws (isDirty) and no buffer resize
    // 3. And not currently animating (isAnimating)
    if (
      !isDirty && 
      !isAnimating && 
      f === lastFrameRef.current && 
      cam === lastCamRef.current
    ) {
      return;
    }

    const isInteracting = v.activeState.interacting;
    let _frameT0 = 0;
    if (PERF_MON) { _frameT0 = performance.now(); }

    // Update snapshot
    lastFrameRef.current = f;
    lastCamRef.current = cam;

    // Clear dirty marks
    needsRenderRef.current = false;

    // [Phase 4] Gets currently active theme (supports System / Dark / Light)
    const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';

    // 4. Execute scheduled rendering (Phase C: resolve display colorSpace via strategy matrix)
    const canvasColorSpace = resolveDisplayColorSpace(f.colorSpace, displaySupportsP3());
    const ctx = canvas.getContext('2d', {
      alpha: true,
      colorSpace: canvasColorSpace,
    }) as CanvasRenderingContext2D;

    if ('attach' in engine) {
      (engine as { attach: (ctx: CanvasRenderingContext2D) => void }).attach(ctx);
    }

    // [Phase 3 — Linear-Light Blend] Set frame color config so engine can
    // decide whether to use linear-light blending for blend mode layers.
    if ('setFrameConfig' in engine) {
      (engine as { setFrameConfig: (config: { trc: string; colorSpace: string }) => void }).setFrameConfig({
        trc: f.trc,
        colorSpace: f.colorSpace,
      });
    }

    let _renderT0 = 0;
    if (PERF_MON) { _renderT0 = performance.now(); }
    stageComposer.render(engine, f, cam, state.ui.viewportDim, geometry, assets, {
      isInteracting,
      getAnimatedRotation,
      displayConfig: channelMask !== 'rgb' ? { channelMask } : undefined,
      getImageOverride: (layerId: string) => {
        const compositeKey = `${f.id}:${layerId}`;
        const draft = v.buffered.layers[compositeKey];
        const result = draft?.imageOverride || undefined;
        if (draft?.imageOverride) {
          console.log('[EraserDebug] getImageOverride:', layerId, '| interacting =', v.activeState.interacting, '| hasDraft =', !!draft, '| returning =', result ? 'OVERRIDE' : 'undefined');
        }
        return result;
      },
      getBitmapMaskOverride: (layerId: string) => {
        const compositeKey = `${f.id}:${layerId}`;
        const draft = v.buffered.layers[compositeKey];
        return draft?.bitmapMaskOverride || undefined;
      },
      theme,
    });

    // ── Phase C (C5): Display-time color space conversion ──
    // When Frame.colorSpace is P3 (or AdobeRGB) but canvas is sRGB
    // (display doesn't support P3), apply CPU matrix conversion on the
    // composited output to ensure accurate color rendering.
    if (f.colorSpace !== 'srgb' && canvasColorSpace === 'srgb') {
      const cw = canvas.width;
      const ch = canvas.height;
      if (cw > 0 && ch > 0) {
        const imageData = ctx.getImageData(0, 0, cw, ch);
        convertImageDataColorSpace(imageData.data, f.colorSpace, 'srgb');
        ctx.putImageData(imageData, 0, 0);
        console.debug(
          '[ColorMgmt] Display: %s→sRGB matrix applied (frame=%s, canvas=%s)',
          f.colorSpace, f.colorSpace, canvasColorSpace,
        );
      }
    }

    if (PERF_MON) {
      const _frameDuration = performance.now() - _frameT0;
      _renderCountRef.current++;
      if (_frameDuration > 16 && _renderCountRef.current > 3) {
        const _renderDuration = performance.now() - _renderT0;
        console.warn(`[CanvasStage.rAF] ⚠️ total=${_frameDuration.toFixed(1)}ms render=${_renderDuration.toFixed(1)}ms layers=${f.layers.order.length} interacting=${isInteracting}`);
      }
    }
  });

  if (!activeFrame) return null;

  // [Critical Fix] CSS dimensions are now managed imperatively inside useFastSync
  // to ensure atomic sync with buffer resize. React-controlled style.width/height
  // was the source of the 1-frame stretch bug on window resize.
  return (
    <canvas 
      ref={canvasRef}
      className="absolute top-0 left-0 bg-transparent"
      style={{ display: 'block' }}
    />
  );
}

// ─── Display Transform: SVG Filter Injection ─────────────────────────────────

const CHANNEL_SVG_ID = '__gpex_channel_filters_svg';

/**
 * Injects hidden SVG filter definitions into the document for GPU-accelerated
 * channel isolation via ctx.filter = 'url(#...)'.
 *
 * Called once on CanvasStage mount. Idempotent — skips if already injected.
 *
 * Single-channel filters (grayscale output):
 * - Red:   R→RGB, A=opaque  (row-major: 1 0 0 0 0 | 1 0 0 0 0 | 1 0 0 0 0 | 0 0 0 0 1)
 * - Green: G→RGB, A=opaque
 * - Blue:  B→RGB, A=opaque
 *
 * Multi-channel filters (color output, disabled channels zeroed):
 * - RG: Keep R and G rows, zero B row
 * - RB: Keep R and B rows, zero G row
 * - GB: Keep G and B rows, zero R row
 */
function ensureChannelFiltersSVG(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(CHANNEL_SVG_ID)) return;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('id', CHANNEL_SVG_ID);
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <!-- Single-channel grayscale filters (preserve original alpha so transparent areas stay transparent) -->
    <filter id="__gpex_ch_red" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 1 0"/>
    </filter>
    <filter id="__gpex_ch_green" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 1 0 0 0  0 1 0 0 0  0 1 0 0 0  0 0 0 1 0"/>
    </filter>
    <filter id="__gpex_ch_blue" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 0 1 0 0  0 0 1 0 0  0 0 1 0 0  0 0 0 1 0"/>
    </filter>
    <!-- Alpha channel: force opaque output (A=1) to visualize alpha value as grayscale -->
    <filter id="__gpex_ch_alpha" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 0 1"/>
    </filter>
    <!-- Multi-channel color filters (disabled channels zeroed) -->
    <filter id="__gpex_ch_rg" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"/>
    </filter>
    <filter id="__gpex_ch_rb" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"/>
    </filter>
    <filter id="__gpex_ch_gb" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0"/>
    </filter>
  `;
  document.body.appendChild(svg);
}
