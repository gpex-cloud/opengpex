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

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { sampleGpuRawData } from "@opengpex/editor/core/engine/utils/sample-utils";

import { SAMPLER_PICK_ATTR } from "./constants";
import { inSamplerChrome, rgbToHex, gridInkFor } from "./helpers";
import type { Rgb, GridInk, ColorSamplerProps } from "./types";
import type { ColorValue } from "@opengpex/editor/core/engine/color";
import { Crosshair } from "./Crosshair";
import { SampleReadout, CapturingHint } from "./Readout";

// The chrome attribute is part of the sampler's public contract (the tool strip
// tags itself with it) — re-export so importers keep a single entry point.
export { SAMPLER_CHROME_ATTR } from "./constants";

/**
 * ColorSampler: a precision eyedropper overlay — crosshair cursor, floating
 * colour capsule and pixel magnifier grid — reading the FROZEN WebGPU document
 * snapshot rather than the on-screen canvas.
 *
 * Why not read the canvas: v2's viewport canvas is owned by
 * `getContext('webgpu')`, and per the HTML spec a second `getContext('2d')` on it
 * returns `null` — the v1 approach cannot work here at all. Instead the owner hook
 * freezes ONE composite snapshot into CPU memory on the PRESS that starts a pick
 * (`pixels.render.capture`), and this component indexes it in memory while the
 * button is held: zero latency, full float precision, document gamut (not the
 * screen's). Hover and pan/zoom do no readback at all.
 *
 * This orchestrator owns ONLY the fragile bits — refs, effects, native event
 * binding, `sampleAt`/`commitSample`, and the latest-ref + `[active]` stabilization
 * (see the `handlersRef` bridge below). Pure presentation lives in `Crosshair`,
 * `SampleReadout` and `CapturingHint`; pure logic in `helpers`/`constants`/`types`.
 *
 * Usage:
 * ```tsx
 * <ColorSampler
 *   active={isSampling}
 *   snapshot={snapshot}
 *   frame={activeFrame}
 *   geometry={geometry}
 *   getCamera={getCamera}
 *   onSample={(hex) => applyColor(hex)}
 *   onCancel={() => setIsSampling(false)}
 * />
 * ```
 */
export function ColorSampler({
  active,
  onSample,
  onCancel,
  snapshot,
  onRequestSnapshot,
  captureExact,
  onReleaseSnapshot,
  frame,
  geometry,
  getCamera,
  currentLayerOnly = false,
  showMagnifier = true,
  showGridLines = true,
  magnifierCellSize = 20,
  magnifierGridSize = 7,
}: ColorSamplerProps) {
  // Current sampled color
  const [sampledColor, setSampledColor] = useState<string | null>(null);

  // Document pixel coordinate (1:1 actual image position)
  const [pixelPos, setPixelPos] = useState<{ x: number; y: number } | null>(
    null,
  );

  // Mouse position (viewport-relative)
  const [mousePos, setMousePos] = useState({ x: -100, y: -100 });

  /** Pointer is over opted-out chrome (the tool strip) → suspend the crosshair,
   *  the readout capsule and the hint, all of which render AT the cursor and
   *  would otherwise cover the very buttons the user is reaching for. */
  const [overChrome, setOverChrome] = useState(false);
  const overChromeRef = useRef(false);

  /** Pointer is over the DOCUMENT IMAGE (not the pasteboard). Drives the
   *  eyedropper cursor: only here does the crosshair replace the system cursor. */
  const [insideImage, setInsideImage] = useState(false);
  const insideImageRef = useRef(false);

  /** Left button is held → we are in a pick (Photoshop point sampling). Sampling
   *  runs ONLY while this is true; hover does nothing but move the crosshair. */
  const [pressing, setPressing] = useState(false);
  const pressingRef = useRef(false);

  // Magnifier pixel grid data
  const [magnifierPixels, setMagnifierPixels] = useState<Rgb[]>([]);
  // The two divider greys for the CURRENT block (see gridInkFor). Computed once
  // per sample so the render path does no colour maths at all.
  const [gridInk, setGridInk] = useState<GridInk | null>(null);

  // Refs
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const sampledColorRef = useRef<ColorValue | null>(null);
  /** Last known cursor position — lets us re-index when the snapshot or camera
   *  changes while the pointer is stationary. */
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  /** Viewport container, resolved once per activation — `sampleAt` runs every
   *  animation frame, and a `querySelector` there is pure waste. */
  const containerRef = useRef<Element | null>(null);
  /** Cached container rect for screen→world projection. The container's box only
   *  moves on window resize / layout change, NOT on canvas pan/zoom, so caching it
   *  keeps the per-move hit-test off the forced-layout path. */
  const rectRef = useRef<DOMRect | null>(null);
  /** Mirrors the cleared/not-cleared state so `clearSample` can no-op. */
  const hasSampleRef = useRef(false);

  useEffect(() => {
    if (!active) {
      containerRef.current = null;
      rectRef.current = null;
      overChromeRef.current = false;
      return;
    }
    const el = document.querySelector(".editor-viewport-container");
    containerRef.current = el;
    const refreshRect = () => {
      rectRef.current = el?.getBoundingClientRect() ?? null;
    };
    refreshRect();
    window.addEventListener("resize", refreshRect);
    // Scroll can shift the container within the page (capture phase catches
    // scrolls on any ancestor); zoom/pan of the canvas does not, so this is rare.
    window.addEventListener("scroll", refreshRect, true);
    return () => {
      window.removeEventListener("resize", refreshRect);
      window.removeEventListener("scroll", refreshRect, true);
      // Drop the eyedropper cursor scope on the way out.
      (el as HTMLElement | null)?.removeAttribute(SAMPLER_PICK_ATTR);
    };
  }, [active]);

  // Grab initial mouse position on activation
  useEffect(() => {
    if (!active) return;

    // Use a one-shot mousemove listener to grab the real cursor position immediately
    const grabInitialPos = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });
      lastPosRef.current = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener("mousemove", grabInitialPos, { once: true });

    return () => {
      document.removeEventListener("mousemove", grabInitialPos);
    };
  }, [active]);

  // Cursor policy: hide the system cursor ONLY over the document image (the
  // container carries `data-sampler-pick` there — see SAMPLER_PICK_ATTR), so the
  // pasteboard and the rest of the app keep their normal cursor. The tool strip
  // hole wins its cursor back with an equal-specificity `!important` rule.
  useEffect(() => {
    if (!active) return;
    const style = document.createElement("style");
    style.id = "opengpex-color-sampler-cursor";
    style.textContent =
      `[${SAMPLER_PICK_ATTR}], [${SAMPLER_PICK_ATTR}] * { cursor: none !important; }\n` +
      `[data-sampler-chrome], [data-sampler-chrome] * { cursor: default !important; }\n` +
      `[data-sampler-chrome] button, [data-sampler-chrome] button * { cursor: pointer !important; }`;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, [active]);

  /**
   * Clear every sampled readout (pointer outside the snapshot coverage).
   *
   * IDEMPOTENT ON PURPOSE: this runs on every animation frame the pointer spends
   * off-canvas. `setMagnifierPixels([])` allocates a fresh array, so React cannot
   * bail out on identity — without the guard, simply moving the cursor outside the
   * artboard re-rendered the whole overlay (every magnifier cell) every frame.
   */
  const clearSample = useCallback(() => {
    if (!hasSampleRef.current) return;
    hasSampleRef.current = false;
    setSampledColor(null);
    sampledColorRef.current = null;
    setPixelPos(null);
    setMagnifierPixels([]);
    // The divider ink is derived from the block we just dropped — leaving it set
    // would paint the next block's grid with the previous block's greys.
    setGridInk(null);
  }, []);

  /**
   * Pointer (client coords) → world point through the LIVE camera.
   *
   * Pan/zoom are NOT frozen while sampling (§3.4①), so the CAMERA is read live per
   * call; only the container's page rect is cached (`rectRef`, refreshed on
   * resize/scroll). `null` when the viewport or camera is unavailable.
   */
  const worldAt = useCallback(
    (clientX: number, clientY: number) => {
      const rect = rectRef.current;
      const cam = getCamera();
      if (!rect || !cam) return null;
      return geometry.space.screenToWorld(
        clientX - rect.left,
        clientY - rect.top,
        frame,
        cam,
      );
    },
    [frame, geometry, getCamera],
  );

  /** Is `world` inside the document image (the artboard), not the pasteboard? */
  const docContains = useCallback(
    (world: { x: number; y: number }) => {
      const x0 = -frame.canvas.w / 2;
      const y0 = -frame.canvas.h / 2;
      return (
        world.x >= x0 &&
        world.y >= y0 &&
        world.x < x0 + frame.canvas.w &&
        world.y < y0 + frame.canvas.h
      );
    },
    [frame],
  );

  /**
   * Sample the frozen snapshot at a screen position (proposal §3.3 #1).
   *
   * The v1 `canvas.getContext('2d')` path is GONE — v2's main canvas is owned by
   * WebGPU, so a 2d context is always `null` there. Instead we inverse-project the
   * pointer through the LIVE camera (`screenToWorld`, pan/zoom are not frozen) and
   * index the in-memory snapshot via `sampleGpuRawData` (which folds in the
   * snapshot's capture scale) — no DPR math anywhere.
   *
   * The snapshot holds RAW premultiplied-linear pixels; `sampleGpuRawData`
   * performs the un-premultiply + gamut + TRC encode for the magnifier window
   * under the cursor only. That is ONE call per sample covering both tracks — the
   * center pixel's precision readout and every magnifier swatch come out of the
   * same block, so a mouse move encodes 25 pixels (5×5), not the whole ROI.
   */
  const sampleAt = useCallback(
    (clientX: number, clientY: number) => {
      if (!snapshot) return;

      const worldPt = worldAt(clientX, clientY);
      if (!worldPt) return;

      // Compute actual 1:1 image pixel position relative to image top-left (0, 0)
      const px = Math.min(
        frame.canvas.w - 1,
        Math.max(0, Math.floor(worldPt.x + frame.canvas.w / 2)),
      );
      const py = Math.min(
        frame.canvas.h - 1,
        Math.max(0, Math.floor(worldPt.y + frame.canvas.h / 2)),
      );
      setPixelPos({ x: px, y: py });

      // Encode the magnifier window (radius 0 = 1x1 when magnifier is off).
      // `sampleGpuRawData` handles world-to-texel mapping, bounds check, clipping,
      // and lazy dual-track terminal encode.
      const half = showMagnifier ? Math.floor(magnifierGridSize / 2) : 0;
      const block = sampleGpuRawData(snapshot, worldPt.x, worldPt.y, half);
      if (!block) {
        clearSample();
        return;
      }
      const { cx, cy, centerIndex: fi } = block;
      const at = (px: number, py: number) =>
        ((py - block.y) * block.w + (px - block.x)) * 4;

      // ── Center pixel: f32 track is the precision truth (§3.2) ──
      const fr = block.float[fi],
        fg = block.float[fi + 1],
        fb = block.float[fi + 2];
      const fa = block.float[fi + 3];

      // 8-bit display track: the swatch / hex / legacy fallback.
      const r = block.rgb8[fi],
        g = block.rgb8[fi + 1],
        b = block.rgb8[fi + 2];
      const hex = rgbToHex(r, g, b);

      setSampledColor(hex);
      // PHASE 1: carry the full structured colour (f32 coords + snapshot gamut),
      // not just the 8-bit hex — the sampler is now a ColorValue source (§7).
      sampledColorRef.current = {
        space: snapshot.gamut,
        coords: { r: fr, g: fg, b: fb },
        alpha: fa,
        hex,
      };
      hasSampleRef.current = true;

      // ── Magnifier grid: 8-bit display track (swatches only, no precision role) ──
      if (showMagnifier) {
        const pixels: Rgb[] = [];
        // Luminance range of the block, folded into this same pass — it feeds
        // the two-tone divider ink (gridInkFor).
        let minLum = 255;
        let maxLum = 0;
        for (let gy = 0; gy < magnifierGridSize; gy++) {
          for (let gx = 0; gx < magnifierGridSize; gx++) {
            const px = cx - half + gx;
            const py = cy - half + gy;
            let pr = 200,
              pg = 200,
              pb = 200;
            if (
              px >= block.x &&
              py >= block.y &&
              px < block.x + block.w &&
              py < block.y + block.h
            ) {
              const idx = at(px, py);
              pr = block.rgb8[idx];
              pg = block.rgb8[idx + 1];
              pb = block.rgb8[idx + 2];
            }
            // else: outside the snapshot coverage — neutral placeholder, which
            // still participates in the range (it is a cell the lines border).
            pixels.push({ r: pr, g: pg, b: pb });
            // Rec.601 luma on the DISPLAY track (already TRC-encoded, i.e. what
            // the eye actually sees on the swatch).
            const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb;
            if (lum < minLum) minLum = lum;
            if (lum > maxLum) maxLum = lum;
          }
        }
        setMagnifierPixels(pixels);
        setGridInk(gridInkFor(minLum, maxLum));
      }
    },
    [snapshot, worldAt, clearSample, showMagnifier, magnifierGridSize, frame],
  );

  /**
   * Commit the pick on RELEASE (A′): hand `onSample` a REAL document pixel.
   *
   * The preview value comes from a screen-resolution snapshot, so at `scale < 1`
   * it is a filtered blend of several document pixels — visually right (it matches
   * the canvas) but not a colour that exists in the document. Here we re-capture a
   * tiny 1:1 window under the cursor and read its centre texel instead.
   *
   * COST: one ~32×32 GPU readback, once, on release — the user is leaving the tool
   * anyway, so the extra frame is invisible.
   *
   * ROBUST TO A FAST CLICK: if the button is released before the press snapshot
   * has landed there is no preview yet, so this does NOT require one — it commits
   * the exact 1:1 read directly and only falls back to the preview when the exact
   * read is unavailable. (The owner QUEUES that read behind the in-flight snapshot
   * rather than dropping it, so a fast click still lands a real pixel.)
   *
   * NEVER EXITS THE TOOL: if nothing can be committed at all, the pick is simply a
   * no-op. A pick is not an exit (Photoshop continuous sampling) — and a failed
   * read is the worst possible moment to yank the user out of the tool.
   */
  const commitSample = useCallback(async () => {
    const p = lastPosRef.current;
    const preview = sampledColorRef.current;
    const worldPt = p ? worldAt(p.x, p.y) : null;

    // Fast path: a 1:1 snapshot already gave a real document pixel.
    if (preview && snapshot && snapshot.scale >= 1) {
      onSample(preview);
      return;
    }

    // Re-read a real document pixel under the cursor (also the fast-click path,
    // where the preview never arrived).
    if (captureExact && worldPt && docContains(worldPt)) {
      try {
        const exact = await captureExact(worldPt);
        if (exact) {
          const block = sampleGpuRawData(exact, worldPt.x, worldPt.y, 0);
          if (block) {
            const i = block.centerIndex;
            const fr = block.float[i],
              fg = block.float[i + 1],
              fb = block.float[i + 2];
            const fa = block.float[i + 3];
            onSample({
              space: exact.gamut,
              coords: { r: fr, g: fg, b: fb },
              alpha: fa,
              hex: rgbToHex(
                block.rgb8[i],
                block.rgb8[i + 1],
                block.rgb8[i + 2],
              ),
            });
            return;
          }
        }
      } catch {
        /* fall back to the preview below */
      }
    }

    if (preview) onSample(preview);
    // else: nothing to commit — keep the tool active and let the user try again.
  }, [captureExact, snapshot, worldAt, docContains, onSample]);

  // ── Latest-ref bridge for the native listener effect ──
  // `sampleAt` / `commitSample` (and friends) change identity whenever `snapshot`
  // updates — and the snapshot lands mid-press, right after mousedown. If the
  // listener effect below depended on them it would tear down and re-subscribe in
  // the middle of a pick, and its cleanup resets `pressingRef` to false — which
  // silently killed drag-sampling and the release commit. Routing every handler
  // through a ref keeps the effect stable (deps: [active] only), so the listeners
  // are bound ONCE per activation and the press state survives snapshot arrival.
  const handlersRef = useRef({
    sampleAt,
    commitSample,
    onCancel,
    onRequestSnapshot,
    onReleaseSnapshot,
    worldAt,
    docContains,
  });
  useEffect(() => {
    handlersRef.current = {
      sampleAt,
      commitSample,
      onCancel,
      onRequestSnapshot,
      onReleaseSnapshot,
      worldAt,
      docContains,
    };
  });

  // Native document-level event listeners (bypass React event system for reliability).
  // Interaction model (Photoshop point sample): PRESS starts a pick and requests the
  // snapshot, DRAG re-samples in-memory, RELEASE commits a 1:1 read and KEEPS the tool
  // active. Hover only moves the crosshair — no sampling, no GPU readback. Wheel /
  // middle-click / space+drag still pass through to the viewport so the user can navigate.
  useEffect(() => {
    if (!active) return;

    /** Update the image hit-test → drives both the crosshair and the scoped
     *  cursor. Called on every move; toggles the container attribute on change. */
    const updateInside = (world: { x: number; y: number } | null) => {
      const inside = !!world && handlersRef.current.docContains(world);
      if (inside === insideImageRef.current) return;
      insideImageRef.current = inside;
      setInsideImage(inside);
      const c = containerRef.current as HTMLElement | null;
      if (!c) return;
      if (inside) c.setAttribute(SAMPLER_PICK_ATTR, "");
      else c.removeAttribute(SAMPLER_PICK_ATTR);
    };

    /**
     * Coalesce everything the pointer drives into ONE animation frame.
     *
     * Gaming mice fire `mousemove` at 125–1000Hz. The old handler called
     * `setMousePos` on every one of them — hundreds of full overlay re-renders a
     * second (crosshair, capsule, 25 magnifier cells), with only the sample itself
     * throttled. Now the event does nothing but record the position; the frame does
     * the projection, the hit-test, the state write and the sample.
     */
    const scheduleFrame = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const p = lastPosRef.current;
        if (!p) return;
        // Keep the identity when the pointer did not actually move (a wheel under a
        // stationary cursor), so React can bail out of the re-render.
        setMousePos((prev) =>
          prev.x === p.x && prev.y === p.y ? prev : { x: p.x, y: p.y },
        );

        // Over the tool strip: no hit-test, no sampling (the user is reaching for a
        // button). Leave the last readout frozen.
        if (overChromeRef.current) {
          updateInside(null);
          return;
        }
        // Hit-test the image (cached rect + live camera) to drive the cursor.
        const world = handlersRef.current.worldAt(p.x, p.y);
        updateInside(world);
        // Sample ONLY while the button is held.
        if (pressingRef.current) handlersRef.current.sampleAt(p.x, p.y);
      });
    };

    const handleMouseMove = (e: MouseEvent) => {
      // Chrome hit-test needs the event target, so it stays on the event; it only
      // writes state on an actual change.
      const chrome = inSamplerChrome(e.target);
      if (chrome !== overChromeRef.current) {
        overChromeRef.current = chrome;
        setOverChrome(chrome);
      }
      lastPosRef.current = { x: e.clientX, y: e.clientY };
      scheduleFrame();
    };

    // Zoom moves the document under a stationary pointer — re-project next frame
    // (the viewport's own wheel handler commits the camera first).
    const handleWheel = () => {
      scheduleFrame();
    };

    const handleMouseDown = (e: MouseEvent) => {
      // Left button only; middle/right pass through for pan / context menu.
      if (e.button !== 0) return;
      // The tool strip's hole: its buttons switch the sampler's own tool.
      if (inSamplerChrome(e.target)) return;
      // A pick starts ONLY on the image — off-image is the native EyeDropper's job,
      // so let that press through untouched.
      const world = handlersRef.current.worldAt(e.clientX, e.clientY);
      if (!world || !handlersRef.current.docContains(world)) return;
      e.preventDefault();
      e.stopPropagation();
      pressingRef.current = true;
      setPressing(true);
      lastPosRef.current = { x: e.clientX, y: e.clientY };
      setMousePos({ x: e.clientX, y: e.clientY });
      // One un-pooled snapshot for this press. When it lands (as the `snapshot`
      // prop) the arrival effect samples at the current position.
      void handlersRef.current.onRequestSnapshot(world);
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button !== 0 || !pressingRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      pressingRef.current = false;
      setPressing(false);
      // Any pending frame is harmless now (its sample is gated on `pressingRef`).
      // Fire-and-forget: `commitSample` resolves through `onSample`, so nothing
      // here needs the result — but the snapshot must outlive it (the fast path
      // reads `snapshot.scale`), hence the release in `finally`.
      void handlersRef.current
        .commitSample()
        .finally(() => handlersRef.current.onReleaseSnapshot?.());
    };

    const handleContextMenu = (e: MouseEvent) => {
      // Right-click cancels sampling — but not when aimed at the tool strip,
      // where the browser menu is harmless and cancelling would be surprising.
      if (inSamplerChrome(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      handlersRef.current.onCancel();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handlersRef.current.onCancel();
      }
      // Allow Space (pan) and other keys to pass through
    };

    // Capture phase so the modal overlay gets first refusal on the button events;
    // mousemove stays in the bubble phase (viewport still needs it for hover states).
    document.addEventListener("mousemove", handleMouseMove, false);
    document.addEventListener("wheel", handleWheel, { passive: true });
    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("mouseup", handleMouseUp, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove, false);
      document.removeEventListener("wheel", handleWheel);
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("mouseup", handleMouseUp, true);
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      pressingRef.current = false;
    };
    // Handlers are read through `handlersRef` (updated every render), so the
    // listeners bind ONCE per activation and never tear down mid-pick.
  }, [active]);

  // The press snapshot lands asynchronously (a GPU render + readback after the
  // mousedown). Sample at the pointer's current position when it arrives, so the
  // first readout appears without needing a move — but ONLY while the button is
  // still held (a released fast-click is committed by `commitSample` instead).
  useEffect(() => {
    if (!active || !snapshot || !pressing) return;
    const p = lastPosRef.current;
    if (!p) return;
    sampleAt(p.x, p.y);
  }, [active, snapshot, pressing, sampleAt]);

  if (!active) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[99999] select-none pointer-events-none"
    >
      {/* ===== Custom Crosshair Cursor ===== */}
      {/* Only over the document image (or while dragging a pick) — off-image the
          system cursor stays and no crosshair is drawn. */}
      {!overChrome && (insideImage || pressing) && (
        <Crosshair x={mousePos.x} y={mousePos.y} />
      )}

      {/* ===== Floating Tooltip: Magnifier Grid (Photoshop point sample) ===== */}
      {/* Press-only magnifier: the panel exists ONLY while the button is held. */}
      {!overChrome && pressing && sampledColor && (
        <SampleReadout
          mousePos={mousePos}
          pixelPos={pixelPos}
          magnifierPixels={magnifierPixels}
          gridInk={gridInk}
          currentLayerOnly={currentLayerOnly}
          showMagnifier={showMagnifier}
          showGridLines={showGridLines}
          magnifierCellSize={magnifierCellSize}
          magnifierGridSize={magnifierGridSize}
        />
      )}

      {/* ===== "Capturing…" hint ===== */}
      {/* Only while a press is in flight and the snapshot has not landed yet.
          Before a press we deliberately show no colour (PS point sample), and
          off-image there is no chrome at all — so no "move to canvas" prompt. */}
      {!overChrome && pressing && !sampledColor && (
        <CapturingHint x={mousePos.x} y={mousePos.y} />
      )}
    </div>,
    document.body,
  );
}

export default ColorSampler;
