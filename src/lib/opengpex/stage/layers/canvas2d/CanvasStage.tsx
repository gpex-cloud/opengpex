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
import { FontService } from '@opengpex/editor/core/fonts';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { useOverlayRotationSync } from '@opengpex/editor/core/motion/hooks/animation';
import { imageCache } from '@opengpex/editor/core/engine/cache/ImageCache';
import { tileCache } from '@opengpex/editor/core/engine/cache/TileCache';
import { asyncFilterCache } from '@opengpex/editor/core/engine/cache/AsyncFilterCache';
// [Filter Pipeline §3.5 hard invariant] AsyncFilterCache is imported ONLY from
// main-thread modules (this file + Canvas2dEngine.ts). painter.ts and any
// worker/** module MUST NOT import it — that would drag WorkerBridge (which
// spins up new Worker(...) at module top-level) into the engine worker's own
// module graph, causing Turbopack to fan out ~30 helper `turbopack-worker-*`
// VMs and crash the landing page (see 2026-07-09 retrospective in spec §3.5.2).



import { useLayerTweens } from './useLayerTweens';
import { stageComposer } from './StageComposer';
import { engine } from '@opengpex/editor/core/engine';

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

  /**
   * renderLoop: Core synchronized rendering logic
   */
  const needsRenderRef = useRef(true); // Default to first render

  // [Font Loading] Inject FontService into engine with redraw callback
  useEffect(() => {
    if ('setFontService' in engine) {
      (engine as { setFontService: (fonts: FontService, cb: () => void) => void }).setFontService(fonts, () => {
        needsRenderRef.current = true;
      });
    }
  }, [fonts]);

  // 1. Subscribe to cache changes; mark redraw needed once slices or full images load
  useEffect(() => {
    const unsubTiles = tileCache.subscribe(() => { needsRenderRef.current = true; });
    const unsubImages = imageCache.subscribe(() => { needsRenderRef.current = true; });
    // [Filter Pipeline §5.2 / Step 3] Redraw when a filtered bitmap lands.
    // Canvas2dEngine.drawLayerDirect schedules async APPLY_FILTER jobs on
    // cache miss and degrades to the raw source for the current frame.
    // Subscribing here ensures the next frame picks up the filtered result.
    const unsubFilters = asyncFilterCache.subscribe(() => { needsRenderRef.current = true; });

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
    const isDirty = needsRenderRef.current;
    
    // [Smart Admission Determination]
    // If all of the following conditions are met, the screen is considered static, skip render:
    // 1. Core geometric states (f, cam) are completely consistent with previous frame
    // 2. No manually marked dirty redraws (isDirty)
    // 3. And not currently animating (isAnimating)
    if (
      !isDirty && 
      !isAnimating && 
      f === lastFrameRef.current && 
      cam === lastCamRef.current
    ) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas || !f || !cam) return;

    const isInteracting = v.activeState.interacting;
    const _frameT0 = performance.now();

    // Update snapshot
    lastFrameRef.current = f;
    lastCamRef.current = cam;

    // Clear dirty marks
    needsRenderRef.current = false;

    // [Phase 3] Physical viewport synchronization and Retina high-DPI adaptation
    const { w, h } = state.ui.viewportDim;
    const dpr = window.devicePixelRatio || 1;
    
    // Only update if viewport dimensions are valid
    if (w > 0 && h > 0) {
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }
    }

    // [Phase 4] Gets currently active theme (supports System / Dark / Light)
    const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';

    // 4. Execute scheduled rendering
    const ctx = canvas.getContext('2d', {
      alpha: true,
      colorSpace: 'display-p3' as PredefinedColorSpace
    }) as CanvasRenderingContext2D;

    if ('attach' in engine) {
      (engine as { attach: (ctx: CanvasRenderingContext2D) => void }).attach(ctx);
    }

    const _renderT0 = performance.now();
    stageComposer.render(engine, f, cam, state.ui.viewportDim, geometry, assets, {
      isInteracting,
      getAnimatedRotation,
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
    const _frameDuration = performance.now() - _frameT0;
    if (_frameDuration > 16) {
      const _renderDuration = performance.now() - _renderT0;
      console.warn(`[CanvasStage.rAF] ⚠️ total=${_frameDuration.toFixed(1)}ms render=${_renderDuration.toFixed(1)}ms layers=${f.layers.order.length} interacting=${isInteracting}`);
    }
  });

  if (!activeFrame) return null;

  return (
    <canvas 
      ref={canvasRef}
      className="absolute top-0 left-0 bg-transparent transition-opacity duration-300"
      style={{
        width: state.ui.viewportDim?.w || activeFrame.canvas.w,
        height: state.ui.viewportDim?.h || activeFrame.canvas.h,
        display: 'block'
      }}
    />
  );
}
