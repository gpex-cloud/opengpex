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

import React, { useState, useRef, useEffect } from "react";
import {
  Monitor,
  RotateCcw,
  RotateCw,
  FlipHorizontal2,
  FlipVertical2,
  ChevronUp,
} from "lucide-react";

import { motion, AnimatePresence } from "framer-motion";
import { useEditorState } from "@opengpex/editor/core/context";
import { CameraState } from "@opengpex/editor/core/types";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import { useViewportCommands } from "./hooks";
import { useFastSync } from "@opengpex/editor/core/motion/hooks/navigation";
import { presets } from "@opengpex/editor/core/helpers/preferences";
const VIEWPORT_ZOOM_MIN = presets.get('VIEWPORT_ZOOM_MIN');
const VIEWPORT_ZOOM_MAX = presets.get('VIEWPORT_ZOOM_MAX');

/**
 * Piecewise-linear scale mapping for zoom slider.
 * The <100% range occupies only 20% of slider travel (compact).
 * The ≥100% range occupies the remaining 80% (expanded).
 * This ensures most slider travel is dedicated to the useful 1x–16x range.
 */
const SLIDER_ZOOM_MAX = Math.min(VIEWPORT_ZOOM_MAX, 32); // Cap UI slider at 3200%
const LOG_ABOVE_MIN = Math.log(1);                   // log(1) = 0
const LOG_ABOVE_MAX = Math.log(SLIDER_ZOOM_MAX);     // log(32)
const SPLIT_T = 0.30; // <100% gets 30% of slider

const BELOW_CURVE = 1.4; // Power curve for <1x zone: >1 pushes .25/.5 slightly higher than pure linear

function sliderToZoom(t: number): number {
  if (t <= SPLIT_T) {
    // Map [0, SPLIT_T] → [ZOOM_MIN, 1] with mild power curve
    const sub = t / SPLIT_T;
    const curved = Math.pow(sub, BELOW_CURVE);
    return VIEWPORT_ZOOM_MIN + curved * (1 - VIEWPORT_ZOOM_MIN);
  }
  // Map [SPLIT_T, 1] → [1, SLIDER_ZOOM_MAX]
  const sub = (t - SPLIT_T) / (1 - SPLIT_T);
  return Math.exp(LOG_ABOVE_MIN + sub * (LOG_ABOVE_MAX - LOG_ABOVE_MIN));
}

function zoomToSlider(k: number): number {
  const clamped = Math.max(VIEWPORT_ZOOM_MIN, Math.min(SLIDER_ZOOM_MAX, k));
  if (clamped <= 1) {
    const linear = (clamped - VIEWPORT_ZOOM_MIN) / (1 - VIEWPORT_ZOOM_MIN);
    const sub = Math.pow(linear, 1 / BELOW_CURVE);
    return sub * SPLIT_T;
  }
  const sub = (Math.log(clamped) - LOG_ABOVE_MIN) / (LOG_ABOVE_MAX - LOG_ABOVE_MIN);
  return SPLIT_T + sub * (1 - SPLIT_T);
}

/** Tick marks for the zoom slider (clickable reference points with snap) */
const ZOOM_TICKS = [0.25, 0.5, 1, 2, 4, 8, 16, 32].filter(v => v >= VIEWPORT_ZOOM_MIN && v <= SLIDER_ZOOM_MAX);

/** Human-friendly tick label */
function tickLabel(tick: number): string {
  if (tick === 0.25) return '.25';
  if (tick === 0.5) return '.5';
  return `${tick}x`;
}

/** Snap threshold: if slider value is within this distance of a tick (in slider space [0,1]), snap to it */
const SNAP_THRESHOLD = 0.02;

/** Apply tick snapping to a raw slider value */
function snapToTick(t: number): number {
  for (const tick of ZOOM_TICKS) {
    const tickT = zoomToSlider(tick);
    if (Math.abs(t - tickT) < SNAP_THRESHOLD) return tickT;
  }
  return t;
}

/**
 * ViewportComponent: Persistent main component for viewport state
 * Uses unified FastSync pipeline drive to ensure absolute synchronization between zoom display and interactions.
 */
export const ViewportComponent = React.memo(function ViewportComponent() {
  const { activeFrame, state } = useEditorState();
  const {
    rotateLeftCmd,
    rotateRightCmd,
    flipHCmd,
    flipVCmd,
    fitCmd,
    actualSizeCmd,
    resetTransformCmd,
    createCameraTx,
  } = useViewportCommands();

  const [isZoomBarOpen, setIsZoomBarOpen] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const latestCamRef = useRef<CameraState | null>(null);
  const syncRef = useRef<HTMLDivElement>(null);
  const cameraTxRef = useRef<ReturnType<typeof createCameraTx> | null>(null);

  // --- 1. Real-time zoom value drive (The Fast Value) ---
  const [displayK, setDisplayK] = useState(activeFrame?.camera?.k || 1);

  // Every-frame synchronization: extracts values from fast-track, eliminating 1 frame delay caused by React lifecycle
  useFastSync(syncRef, !!activeFrame, (v, f, cam) => {
    latestCamRef.current = cam;
    if (Math.abs(displayK - cam.k) > 0.001) {
      setDisplayK(cam.k);
    }
  });

  // [Compass Logic] Extract layer physical rotation as sole truth
  const baseLayer = activeFrame
    ? activeFrame.layers.byId[activeFrame.layers.order[0]]
    : undefined;
  const targetRotation = baseLayer?.rotation || 0;
  const isFlipped = !!(baseLayer?.flip.h || baseLayer?.flip.v);

  const [visualRotation, setVisualRotation] = useState(targetRotation);
  const lastTargetRef = useRef(targetRotation);

  useEffect(() => {
    const delta = ((targetRotation - lastTargetRef.current + 540) % 360) - 180;
    setVisualRotation((prev) => prev + delta);
    lastTargetRef.current = targetRotation;
  }, [targetRotation]);

  if (!activeFrame) return null;

  // --- 2. Interaction handles ---
  const handleMouseEnter = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
  };

  const handleMouseLeave = () => {
    hoverTimeoutRef.current = setTimeout(() => {
      setIsZoomBarOpen(false);
    }, 150);
  };

  /** Shared zoom-to-center logic for both slider drag and tick click */
  const applyZoom = (newK: number) => {
    const currentCam = latestCamRef.current || activeFrame.camera;
    const { x, y, k: oldK } = currentCam;

    // Center-pivot: recalculate x/y to keep viewport center stable
    const { w: vw, h: vh } = state.ui.viewportDim;
    const { insets } = state.ui.theme.config;
    const centerX = (vw + insets.fixed.left - insets.fixed.right) / 2;
    const centerY = (vh + insets.top - insets.bottom) / 2;
    const nextX = centerX - (centerX - x) * (newK / oldK);
    const nextY = centerY - (centerY - y) * (newK / oldK);

    if (!cameraTxRef.current) {
      cameraTxRef.current = createCameraTx(activeFrame.id);
      cameraTxRef.current.begin();
    }
    cameraTxRef.current.override({ ...currentCam, x: nextX, y: nextY, k: newK });
  };

  // Sliding process: directly injects into fast-track (60FPS) with snap-to-tick
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawT = parseFloat(e.target.value);
    const t = snapToTick(rawT);
    applyZoom(sliderToZoom(t));
  };

  // Click a tick mark to jump directly to that zoom level
  const handleTickClick = (tick: number) => {
    applyZoom(tick);
    // Immediately commit (single click = final value)
    if (cameraTxRef.current) {
      cameraTxRef.current.commit();
      cameraTxRef.current = null;
    }
  };

  // Slide end: formally commit to slow-track
  const handleSliderCommit = () => {
    if (cameraTxRef.current) {
      cameraTxRef.current.commit();
      cameraTxRef.current = null;
    }
  };

  return (
    <div ref={syncRef} className="flex items-center gap-1 -mr-1 animate-in fade-in slide-in-from-left-2 duration-300">
      <div className="flex items-center gap-2">
        <motion.div
          animate={{ rotate: visualRotation }}
          transition={{ type: "spring", stiffness: 260, damping: 22 }}
          className="cursor-pointer"
          onClick={() => resetTransformCmd.execute()}
          title={`${resetTransformCmd.name} (${resetTransformCmd.shortcutLabel})`}
        >
          <Monitor
            size={12}
            className={`transition-colors duration-300 ${
              isFlipped
                ? "text-rose-500"
                : targetRotation % 360 !== 0
                  ? "text-amber-500"
                  : "text-[var(--text-muted)]"
            }`}
          />
        </motion.div>
        <span className="text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest hidden sm:inline">
          View
        </span>
      </div>

      {/* Resolution Display */}
      {/* <div className="flex items-center gap-1 px-1">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tighter opacity-70">
          Res
        </span>
        <span className="text-[11px] font-bold text-[var(--text-main)] tabular-nums">
          {Math.round(activeFrame.canvas.w)}{" "}
          <span className="text-[var(--text-muted)] font-normal">×</span>{" "}
          {Math.round(activeFrame.canvas.h)}
        </span>
      </div> */}

      {/* Zoom Control */}
      <div
        className="relative group flex items-center"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div
          onClick={() => setIsZoomBarOpen((p) => !p)}
          className="flex items-center gap-1 px-1 h-7 rounded-lg hover:bg-[var(--bg-stage)] transition-all cursor-pointer"
        >
          {/* <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tighter opacity-70">
            Zoom
          </span> */}
          <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 tabular-nums min-w-[32px] text-center">
            {Math.round(displayK * 100)}%
          </span>
          <ChevronUp
            size={10}
            className={`text-[var(--text-muted)] transition-transform duration-300 ${isZoomBarOpen ? "rotate-180" : ""}`}
          />
        </div>

        <AnimatePresence>
          {isZoomBarOpen && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 5 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 5 }}
              className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-2 bg-[var(--bg-panel)] backdrop-blur-xl border border-[var(--border-light)] rounded-xl shadow-2xl z-50 flex items-center ring-1 ring-black/5 gap-1"
            >
              {/* Tick marks (left side) — clickable with 20px tall hit area */}
              <div className="relative h-[156px] w-[24px]">
                {ZOOM_TICKS.map(tick => (
                  <button
                    key={tick}
                    onClick={() => handleTickClick(tick)}
                    className="absolute left-0 w-full h-5 flex items-center justify-end pr-0.5 cursor-pointer hover:opacity-100 transition-opacity"
                    style={{ bottom: `calc(${zoomToSlider(tick) * 100}% - 10px)`, opacity: 0.75 }}
                    title={`${Math.round(tick * 100)}%`}
                  >
                    <span className={`text-[9px] tabular-nums font-bold ${tick === 1 ? 'text-indigo-500' : 'text-[var(--text-main)]'}`}>
                      {tickLabel(tick)}
                    </span>
                  </button>
                ))}
              </div>

              {/* Slider track */}
              <div className="flex flex-col items-center h-[156px] w-4 relative overflow-visible">
                {/* Tick lines — also clickable */}
                {ZOOM_TICKS.map(tick => (
                  <div
                    key={tick}
                    onClick={() => handleTickClick(tick)}
                    className="absolute left-0 right-0 h-4 flex items-center cursor-pointer"
                    style={{ bottom: `calc(${zoomToSlider(tick) * 100}% - 8px)` }}
                  >
                    <div className="w-full h-px" style={{ background: tick === 1 ? '#6366f1' : 'var(--border-light)', opacity: tick === 1 ? 0.8 : 0.4 }} />
                  </div>
                ))}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.002"
                  value={zoomToSlider(displayK)}
                  onChange={handleSliderChange}
                  onMouseUp={handleSliderCommit}
                  onKeyUp={handleSliderCommit}
                  className="zoom-slider-vertical"
                  style={
                    {
                      "--zoom-percent": `${zoomToSlider(displayK) * 100}%`,
                    } as React.CSSProperties
                  }
                />
                <style jsx>{`
                  .zoom-slider-vertical {
                    -webkit-appearance: none;
                    width: 156px;
                    height: 2px;
                    background: transparent;
                    transform: rotate(-90deg);
                    transform-origin: center;
                    cursor: ns-resize;
                    position: absolute;
                    top: 77px;
                    margin: 0;
                  }
                  .zoom-slider-vertical::-webkit-slider-runnable-track {
                    width: 100%;
                    height: 2px;
                    cursor: pointer;
                    background: linear-gradient(
                      to right,
                      #6366f1 var(--zoom-percent),
                      #e4e4e7 var(--zoom-percent)
                    );
                    border-radius: 1px;
                  }
                  .dark .zoom-slider-vertical::-webkit-slider-runnable-track {
                    background: linear-gradient(
                      to right,
                      #818cf8 var(--zoom-percent),
                      #27272a var(--zoom-percent)
                    );
                  }
                  .zoom-slider-vertical::-webkit-slider-thumb {
                    height: 10px;
                    width: 10px;
                    border-radius: 50%;
                    background: #6366f1;
                    cursor: ns-resize;
                    -webkit-appearance: none;
                    margin-top: -4px;
                    box-shadow:
                      0 0 8px rgba(99, 102, 241, 0.4),
                      0 0 0 2px rgba(255, 255, 255, 1);
                    border: none;
                  }
                  .dark .zoom-slider-vertical::-webkit-slider-thumb {
                    background: #818cf8;
                    box-shadow:
                      0 0 8px rgba(129, 140, 248, 0.4),
                      0 0 0 2px rgba(39, 39, 42, 1);
                  }
                `}</style>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center">
        <FancyButton shape="rect"
          onClick={() => fitCmd.execute()}
          variant="ghost"
          title={`${fitCmd.name} (${fitCmd.shortcutLabel})`}
          tooltipPosition="bottom"
          className="h-6 w-auto px-1 text-[10px] text-emerald-600 dark:text-emerald-400"
        >
          FIT
        </FancyButton>
        <FancyButton shape="rect"
          onClick={() => actualSizeCmd.execute()}
          variant="ghost"
          title={`${actualSizeCmd.name} (${actualSizeCmd.shortcutLabel})`}
          tooltipPosition="bottom"
          className="h-6 w-auto px-1 text-[10px] text-emerald-600 dark:text-emerald-400"
        >
          1:1
        </FancyButton>
      </div>

      <div className="flex items-center">
        <FancyButton shape="rect" iconOnly
          onClick={() => rotateLeftCmd.execute()}
          variant="ghost"
          title={`${rotateLeftCmd.name} (${rotateLeftCmd.shortcutLabel})`}
          tooltipPosition="bottom"
          className="w-6 h-6 text-sky-500"
        >
          <RotateCcw size={13} />
        </FancyButton>
        <FancyButton shape="rect" iconOnly
          onClick={() => rotateRightCmd.execute()}
          variant="ghost"
          title={`${rotateRightCmd.name} (${rotateRightCmd.shortcutLabel})`}
          tooltipPosition="bottom"
          className="w-6 h-6 text-sky-500"
        >
          <RotateCw size={13} />
        </FancyButton>
        <div className="w-px h-3 bg-transparent mx-0.5" />
        <FancyButton shape="rect" iconOnly
          onClick={() => flipHCmd.execute()}
          variant="ghost"
          title={`${flipHCmd.name} (${flipHCmd.shortcutLabel})`}
          tooltipPosition="bottom"
          className="w-6 h-6 text-indigo-500"
        >
          <FlipHorizontal2 size={13} />
        </FancyButton>
        <FancyButton shape="rect" iconOnly
          onClick={() => flipVCmd.execute()}
          variant="ghost"
          title={`${flipVCmd.name} (${flipVCmd.shortcutLabel})`}
          tooltipPosition="bottom"
          className="w-6 h-6 text-indigo-500"
        >
          <FlipVertical2 size={13} />
        </FancyButton>
      </div>
    </div>
  );
});
