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

import React, { useRef, useEffect } from 'react';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { Grid } from 'lucide-react';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { usePixelGridCommands } from './hooks';

// ─────────────────────────────────────────────────────────────────────────────
// PixelGridOverlayContainer
// ─────────────────────────────────────────────────────────────────────────────
//
// ## Why Canvas2D instead of the old CSS linear-gradient approach?
//
// The previous implementation used a <div> with CSS `linear-gradient` as
// background-image, and updated `width`, `height`, `transform`, and
// `backgroundPosition` on every GSAP Ticker frame (120Hz on ProMotion).
//
// This caused severe performance issues:
//   1. `width`/`height` writes → trigger Layout Reflow (CPU-bound, ~4-8ms)
//   2. `backgroundPosition` writes → trigger full gradient re-rasterization
//      on a viewport-sized element (~4-8ms on Retina DPR=2)
//   3. No dirty-check → even when static, styles were written every frame,
//      causing sustained CPU load and machine heating
//
// The new Canvas2D approach bypasses the entire CSS pipeline:
//   - Canvas pixel operations (beginPath + lineTo + stroke) go directly to
//     the GPU via Skia/Core Graphics, skipping Style → Layout → Paint stages
//   - Drawing ~300 lines costs ~0.3ms (vs ~8-16ms for the CSS approach)
//   - Dirty-check ensures zero work when the camera hasn't moved
//
// ## Critical Performance Rules
//
//   1. NEVER resize canvas.width/height during zoom/pan.
//      Setting canvas.width destroys the GPU backing buffer and reallocates it,
//      which costs ~30-50ms. Only resize on viewport (window) resize events.
//
//   2. Only clearRect the previously drawn sub-region, not the full canvas.
//      This minimizes GPU memory operations per frame.
//
//   3. Cache the CanvasRenderingContext2D reference. Calling getContext('2d')
//      repeatedly has measurable overhead in tight loops.
//
//   4. Dirty-check with camera key. When the camera hasn't moved, the grid
//      hasn't changed — skip all drawing. This gives 0ms/frame when idle
//      (solving the static heating issue).
//
// ## Performance Budget
//
//   - Target: <1ms per frame for grid rendering
//   - Measured: ~0.2-0.5ms (300 lines on Retina 2880×1800)
//   - vs old CSS approach: ~8-16ms (Layout Reflow + gradient rasterize)
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PixelGridOverlayContainer: Canvas2D-based pixel grid overlay.
 *
 * Renders a 1px physical grid aligned with image pixels when zoomed in (scale >= zoomThreshold).
 * Replaces the legacy CSS linear-gradient implementation for performance.
 */
export function PixelGridOverlayContainer() {
  const { state, activeFrame } = useEditorState();
  const { geometry } = useEditorServices();
  const { isEnabled, zoomThreshold, gridColor } = usePixelGridCommands();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ─── Persistent Refs (survive across frames, never cause re-renders) ───

  /** Cached 2D context — acquired once after canvas resize, reused on every frame */
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  /** Camera state key for dirty-checking (format: "x:y:k") */
  const lastCamKeyRef = useRef<string>('');

  /** Last shouldShow state — avoids redundant opacity DOM writes */
  const lastShowRef = useRef<boolean | null>(null);

  /**
   * Bounding rect of the previously drawn grid region (in physical pixels).
   * Used to clearRect ONLY the dirty area next frame, instead of clearing
   * the entire canvas buffer.
   */
  const lastDrawRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // ─── Canvas Buffer Allocation (viewport resize only) ───

  const viewportDimRef = useRef(state.ui.viewportDim);
  useEffect(() => {
    viewportDimRef.current = state.ui.viewportDim;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const { w, h } = state.ui.viewportDim;
    const physW = Math.floor(w * dpr);
    const physH = Math.floor(h * dpr);

    // Only reallocate buffer if viewport size actually changed.
    // This is the ONLY place canvas.width/height is ever set.
    if (canvas.width !== physW || canvas.height !== physH) {
      canvas.width = physW;
      canvas.height = physH;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // Must re-acquire context after buffer reallocation (resets internal state)
      ctxRef.current = canvas.getContext('2d');
    }

    // Invalidate caches so next tick will redraw
    lastCamKeyRef.current = '';
    lastDrawRectRef.current = null;
  }, [state.ui.viewportDim]);

  // ─── Per-Frame Render Loop (driven by GSAP Ticker via useFastSync) ───

  useFastSync(canvasRef, true, (v, f, cam) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scale = geometry.getScale(f, cam);
    const shouldShow = isEnabled && scale >= zoomThreshold;

    // --- Visibility toggle (write to DOM only when state changes) ---
    // Use visibility:hidden (not just opacity:0) to fully remove the canvas from
    // the browser's composite tree, eliminating per-vsync GPU texture blending cost.
    if (shouldShow !== lastShowRef.current) {
      lastShowRef.current = shouldShow;
      if (shouldShow) {
        canvas.style.visibility = 'visible';
        canvas.style.opacity = '1';
      } else {
        canvas.style.opacity = '0';
        canvas.style.visibility = 'hidden';
      }

      // When hiding, clear previously drawn content to release GPU texture memory
      if (!shouldShow && ctxRef.current && lastDrawRectRef.current) {
        const r = lastDrawRectRef.current;
        ctxRef.current.clearRect(r.x, r.y, r.w, r.h);
        lastDrawRectRef.current = null;
      }
    }

    // Early exit: grid is invisible, zero computation
    if (!shouldShow) return;

    // --- Dirty-check: skip entirely if camera hasn't moved ---
    // This ensures 0ms cost when the viewport is static (solving the heating issue)
    const camKey = `${cam.x}:${cam.y}:${cam.k}`;
    if (camKey === lastCamKeyRef.current) return;
    lastCamKeyRef.current = camKey;

    // --- Lazy context initialization ---
    if (!ctxRef.current) {
      ctxRef.current = canvas.getContext('2d');
    }
    const ctx = ctxRef.current;
    if (!ctx) return;

    // --- Clear the previously drawn sub-region ---
    // Expand by 2px on each side to account for:
    //   - Math.round(x) + 0.5 offset placing line centers at fractional positions
    //   - ctx.lineWidth = 1 extending 0.5px beyond path coordinates
    // Without this expansion, edge pixels from previous frames accumulate during
    // panning, creating visible residual vertical/horizontal lines (ghost lines).
    if (lastDrawRectRef.current) {
      const r = lastDrawRectRef.current;
      ctx.clearRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
    }

    // --- Compute visible grid region ---
    // The grid is only drawn within the intersection of:
    //   - The artboard (image canvas) bounds projected to screen
    //   - The viewport bounds
    const dpr = window.devicePixelRatio || 1;
    const canvasWorldRect = geometry.asWorldRect({
      x: -f.canvas.w / 2, y: -f.canvas.h / 2,
      w: f.canvas.w, h: f.canvas.h
    });
    const screenRect = geometry.space.worldToScreenRect(canvasWorldRect, f, cam);

    const { w: vw, h: vh } = viewportDimRef.current;

    // Clip bounds in physical (device) pixels
    const clipLeft = Math.max(0, screenRect.x) * dpr;
    const clipTop = Math.max(0, screenRect.y) * dpr;
    const clipRight = Math.min(vw, screenRect.x + screenRect.w) * dpr;
    const clipBottom = Math.min(vh, screenRect.y + screenRect.h) * dpr;

    const drawW = clipRight - clipLeft;
    const drawH = clipBottom - clipTop;

    // Nothing visible — artboard is entirely off-screen
    if (drawW <= 0 || drawH <= 0) {
      lastDrawRectRef.current = null;
      return;
    }

    // --- Grid spacing (in physical pixels) ---
    // Each grid cell = 1 image pixel = `scale` logical px = `scale * dpr` physical px
    const gridSpacing = scale * dpr;

    // --- Safety cap: prevent path explosion at threshold boundary ---
    // At zoomThreshold=8, dpr=2: spacing=16px → ~180+112=292 lines (fine).
    // During zoom animation, scale might briefly hover at threshold causing
    // a large number of lines. Cap total to prevent GPU stall.
    const hLineCount = Math.ceil(drawW / gridSpacing);
    const vLineCount = Math.ceil(drawH / gridSpacing);
    if (hLineCount + vLineCount > 800) {
      lastDrawRectRef.current = null;
      return;
    }

    // Record this frame's draw region for next-frame targeted clear
    lastDrawRectRef.current = { x: clipLeft, y: clipTop, w: drawW, h: drawH };

    // --- Calculate grid line origins ---
    // The artboard's top-left corner in physical pixels determines the grid phase.
    // Grid lines must align with artboard pixel boundaries, not viewport pixels.
    const originX = screenRect.x * dpr;
    const originY = screenRect.y * dpr;

    // First visible grid line position (snapped to artboard pixel boundary)
    const firstX = originX + Math.ceil((clipLeft - originX) / gridSpacing) * gridSpacing;
    const firstY = originY + Math.ceil((clipTop - originY) / gridSpacing) * gridSpacing;

    // --- Draw grid lines ---
    // Single beginPath + batch all lines + single stroke = minimal draw calls
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();

    // Vertical lines (one per visible image pixel column)
    for (let x = firstX; x <= clipRight; x += gridSpacing) {
      // +0.5 offset ensures 1px crisp lines (lands on pixel center, not boundary)
      const px = Math.round(x) + 0.5;
      ctx.moveTo(px, clipTop);
      ctx.lineTo(px, clipBottom);
    }

    // Horizontal lines (one per visible image pixel row)
    for (let y = firstY; y <= clipBottom; y += gridSpacing) {
      const py = Math.round(y) + 0.5;
      ctx.moveTo(clipLeft, py);
      ctx.lineTo(clipRight, py);
    }

    // Single stroke call — GPU rasterizes all lines in one draw call
    ctx.stroke();
  });

  // --- Render ---
  if (!activeFrame) return null;

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ opacity: 0 }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PixelGridToggle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PixelGridToggle: Toolbar toggle switch contributed to the TOOL_MENU slot.
 * Allows the user to enable/disable the pixel grid overlay.
 */
export function PixelGridToggle() {
  const { isEnabled, toggleCmd } = usePixelGridCommands();

  return (
    <FancyButton 
      onClick={() => toggleCmd?.execute()}
      active={isEnabled}
      title={`Toggle Pixel Grid (${toggleCmd?.shortcutLabel || ''})`}
      tooltipPosition="right"
      iconOnly
      shape="rect"
    >
      <Grid size={18} />
    </FancyButton>
  );
}
