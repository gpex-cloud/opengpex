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

// ============================================================
// Types
// ============================================================

interface ColorSamplerProps {
  /** Whether the sampler overlay is active */
  active: boolean;
  /** Called with the sampled hex color string when user clicks */
  onSample: (color: string) => void;
  /** Called when user cancels (Escape key) */
  onCancel: () => void;
  /** Whether to show the pixel magnifier grid (default: true) */
  showMagnifier?: boolean;
  /** Whether to show grid lines between pixels in the magnifier (default: true) */
  showGridLines?: boolean;
  /** Size of each pixel cell in the magnifier grid in px (default: 12) */
  magnifierCellSize?: number;
  /** Grid dimension (must be odd for center pixel, default: 9) */
  magnifierGridSize?: number;
}

// ============================================================
// Helpers
// ============================================================

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = x.toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
  );
}

/** Determines whether a color is "light" for contrast purposes */
function isLightColor(r: number, g: number, b: number): boolean {
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6;
}

// ============================================================
// Component
// ============================================================

/**
 * ColorSampler: A custom canvas-based color picker overlay that replaces
 * the browser's native EyeDropper circle with a precision crosshair, floating
 * color preview, and optional pixel magnifier grid.
 *
 * Usage:
 * ```tsx
 * <ColorSampler
 *   active={isSampling}
 *   onSample={(hex) => applyColor(hex)}
 *   onCancel={() => setIsSampling(false)}
 * />
 * ```
 */
export function ColorSampler({
  active,
  onSample,
  onCancel,
  showMagnifier = true,
  showGridLines = true,
  magnifierCellSize = 12,
  magnifierGridSize = 9,
}: ColorSamplerProps) {
  // Current sampled color
  const [sampledColor, setSampledColor] = useState<string | null>(null);
  const [sampledRgb, setSampledRgb] = useState<{
    r: number;
    g: number;
    b: number;
  } | null>(null);

  // Mouse position (viewport-relative)
  const [mousePos, setMousePos] = useState({ x: -100, y: -100 });

  // Magnifier pixel grid data
  const [magnifierPixels, setMagnifierPixels] = useState<
    { r: number; g: number; b: number }[]
  >([]);

  // Refs
  const canvasSourceRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const sampledColorRef = useRef<string | null>(null);

  // Grab initial mouse position on activation
  useEffect(() => {
    if (!active) return;

    // Use a one-shot mousemove listener to grab the real cursor position immediately
    const grabInitialPos = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("mousemove", grabInitialPos, { once: true });

    return () => {
      document.removeEventListener("mousemove", grabInitialPos);
    };
  }, [active]);

  // Find the editor canvas element
  useEffect(() => {
    if (!active) {
      canvasSourceRef.current = null;
      return;
    }
    // Look for the canvas inside the viewport container
    const canvas = document.querySelector(
      ".editor-viewport-container canvas",
    ) as HTMLCanvasElement | null;
    canvasSourceRef.current = canvas;
  }, [active]);

  // Hide system cursor globally while active
  useEffect(() => {
    if (!active) return;
    const style = document.createElement("style");
    style.id = "fancy-color-sampler-cursor-hide";
    style.textContent = `* { cursor: none !important; }`;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, [active]);

  // Sample pixel at position
  const sampleAt = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasSourceRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      // Map client coords to canvas pixel coords
      const canvasX = Math.round((clientX - rect.left) * dpr);
      const canvasY = Math.round((clientY - rect.top) * dpr);

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;

      // Check bounds
      if (
        canvasX < 0 ||
        canvasY < 0 ||
        canvasX >= canvas.width ||
        canvasY >= canvas.height
      ) {
        setSampledColor(null);
        setSampledRgb(null);
        sampledColorRef.current = null;
        setMagnifierPixels([]);
        return;
      }

      // Sample center pixel
      const pixel = ctx.getImageData(canvasX, canvasY, 1, 1).data;
      const r = pixel[0],
        g = pixel[1],
        b = pixel[2];
      const hex = rgbToHex(r, g, b);
      setSampledColor(hex);
      setSampledRgb({ r, g, b });
      sampledColorRef.current = hex;

      // Sample magnifier grid
      if (showMagnifier) {
        const half = Math.floor(magnifierGridSize / 2);
        const pixels: { r: number; g: number; b: number }[] = [];

        // Get a larger region in one call for performance
        const startX = canvasX - half;
        const startY = canvasY - half;
        const regionSize = magnifierGridSize;

        // Clamp to canvas bounds for getImageData
        const safeX = Math.max(0, startX);
        const safeY = Math.max(0, startY);
        const safeW = Math.min(canvas.width - safeX, regionSize + (startX - safeX));
        const safeH = Math.min(canvas.height - safeY, regionSize + (startY - safeY));

        let imageData: ImageData | null = null;
        if (safeW > 0 && safeH > 0) {
          imageData = ctx.getImageData(safeX, safeY, safeW, safeH);
        }

        for (let gy = 0; gy < regionSize; gy++) {
          for (let gx = 0; gx < regionSize; gx++) {
            const px = startX + gx;
            const py = startY + gy;

            if (
              px < 0 ||
              py < 0 ||
              px >= canvas.width ||
              py >= canvas.height ||
              !imageData
            ) {
              // Out of bounds: transparent/checker
              pixels.push({ r: 200, g: 200, b: 200 });
            } else {
              const localX = px - safeX;
              const localY = py - safeY;
              const idx = (localY * safeW + localX) * 4;
              pixels.push({
                r: imageData.data[idx],
                g: imageData.data[idx + 1],
                b: imageData.data[idx + 2],
              });
            }
          }
        }
        setMagnifierPixels(pixels);
      }
    },
    [showMagnifier, magnifierGridSize],
  );

  // Native document-level event listeners (bypass React event system for reliability)
  // NOTE: We only intercept left-click and Escape. Wheel, middle-click, and
  // space+drag are NOT intercepted — they pass through to the Viewport's
  // pan/zoom handlers so users can navigate while sampling.
  useEffect(() => {
    if (!active) return;

    const handleMouseMove = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });

      // Throttle sampling with rAF
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        sampleAt(e.clientX, e.clientY);
      });
    };

    const handleMouseDown = (e: MouseEvent) => {
      // Only intercept primary (left) button clicks for sampling
      // Middle-click (button=1), right-click (button=2) pass through for pan
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (sampledColorRef.current) {
        onSample(sampledColorRef.current);
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
      // Allow Space (pan) and other keys to pass through
    };

    // Use capture phase to intercept events before anything else
    // mousemove: capture but don't stop propagation (viewport still gets it for hover states)
    document.addEventListener("mousemove", handleMouseMove, false);
    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove, false);
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      cancelAnimationFrame(rafRef.current);
    };
  }, [active, sampleAt, onSample, onCancel]);

  if (!active) return null;

  // Calculate tooltip position (offset from cursor to avoid overlap)
  const tooltipOffset = 20;
  const magnifierW = magnifierGridSize * magnifierCellSize;
  // Tooltip outer dimensions (grid + padding + border + swatch row + hint row + gaps)
  const tooltipOuterW = magnifierW + 18; // 8px padding × 2 + 1px border × 2
  const tooltipOuterH = magnifierW + 80; // grid + swatch(40) + hint(20) + gaps(12) + padding(16) + border(2) ≈ +80

  // Determine if tooltip should flip (near edges)
  const viewW = typeof window !== "undefined" ? window.innerWidth : 1920;
  const viewH = typeof window !== "undefined" ? window.innerHeight : 1080;
  const flipX = mousePos.x + tooltipOffset + tooltipOuterW > viewW;
  const flipY = mousePos.y + tooltipOffset + tooltipOuterH > viewH;

  const tooltipX = flipX
    ? mousePos.x - tooltipOffset - tooltipOuterW
    : mousePos.x + tooltipOffset;
  const tooltipY = flipY
    ? mousePos.y - tooltipOffset - tooltipOuterH
    : mousePos.y + tooltipOffset;

  const textColor =
    sampledRgb && isLightColor(sampledRgb.r, sampledRgb.g, sampledRgb.b)
      ? "text-zinc-900"
      : "text-white";

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[99999] select-none pointer-events-none"
    >

      {/* ===== Custom Crosshair Cursor ===== */}
      <div
        className="fixed pointer-events-none"
        style={{
          left: mousePos.x,
          top: mousePos.y,
          transform: "translate(-50%, -50%)",
        }}
      >
        {/* Outer crosshair lines */}
        <svg
          width="32"
          height="32"
          viewBox="0 0 32 32"
          fill="none"
          className="drop-shadow-sm"
        >
          {/* Horizontal line */}
          <line
            x1="0"
            y1="16"
            x2="12"
            y2="16"
            stroke="white"
            strokeWidth="1.5"
          />
          <line
            x1="20"
            y1="16"
            x2="32"
            y2="16"
            stroke="white"
            strokeWidth="1.5"
          />
          {/* Vertical line */}
          <line
            x1="16"
            y1="0"
            x2="16"
            y2="12"
            stroke="white"
            strokeWidth="1.5"
          />
          <line
            x1="16"
            y1="20"
            x2="16"
            y2="32"
            stroke="white"
            strokeWidth="1.5"
          />
          {/* Center dot */}
          <rect
            x="14.5"
            y="14.5"
            width="3"
            height="3"
            stroke="white"
            strokeWidth="1"
            fill="none"
          />
          {/* Shadow lines for contrast */}
          <line
            x1="0"
            y1="16"
            x2="12"
            y2="16"
            stroke="black"
            strokeWidth="0.5"
            opacity="0.4"
          />
          <line
            x1="20"
            y1="16"
            x2="32"
            y2="16"
            stroke="black"
            strokeWidth="0.5"
            opacity="0.4"
          />
          <line
            x1="16"
            y1="0"
            x2="16"
            y2="12"
            stroke="black"
            strokeWidth="0.5"
            opacity="0.4"
          />
          <line
            x1="16"
            y1="20"
            x2="16"
            y2="32"
            stroke="black"
            strokeWidth="0.5"
            opacity="0.4"
          />
        </svg>
      </div>

      {/* ===== Floating Tooltip: Color Preview + Hex + Magnifier ===== */}
      {sampledColor && (
        <div
          className="fixed pointer-events-none animate-in fade-in duration-100"
          style={{
            left: tooltipX,
            top: tooltipY,
          }}
        >
          <div
            className="flex flex-col gap-1.5 bg-zinc-900/90 backdrop-blur-xl border border-white/10 rounded-xl p-2 shadow-2xl"
            style={{ width: magnifierW + 18 }}
          >
            {/* Color swatch + hex value */}
            <div className="flex items-center gap-2">
              <div
                className="w-8 h-8 rounded-lg ring-1 ring-inset ring-white/20 shadow-inner shrink-0"
                style={{ backgroundColor: sampledColor }}
              />
              <div className="flex flex-col">
                <span className="text-[11px] font-mono font-bold text-white/90 uppercase tracking-wide">
                  {sampledColor}
                </span>
                {sampledRgb && (
                  <span className="text-[9px] font-mono text-white/50">
                    {sampledRgb.r}, {sampledRgb.g}, {sampledRgb.b}
                  </span>
                )}
              </div>
            </div>

            {/* Magnifier Grid */}
            {showMagnifier && magnifierPixels.length > 0 && (
              <div
                className="rounded-lg overflow-hidden ring-1 ring-white/10 relative"
                style={{
                  width: magnifierW,
                  height: magnifierW,
                }}
              >
                {/* Pixel grid */}
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: `repeat(${magnifierGridSize}, ${magnifierCellSize}px)`,
                    gridTemplateRows: `repeat(${magnifierGridSize}, ${magnifierCellSize}px)`,
                  }}
                >
                  {magnifierPixels.map((px, i) => {
                    const isCenter =
                      i ===
                      Math.floor(magnifierGridSize / 2) * magnifierGridSize +
                        Math.floor(magnifierGridSize / 2);
                    return (
                      <div
                        key={i}
                        className={`relative ${isCenter ? "ring-2 ring-white z-10 shadow-sm" : ""}`}
                        style={{
                          backgroundColor: rgbToHex(px.r, px.g, px.b),
                          width: magnifierCellSize,
                          height: magnifierCellSize,
                        }}
                      >
                        {isCenter && (
                          <div className="absolute inset-0 ring-1 ring-inset ring-black/30" />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Grid lines overlay (optional) */}
                {showGridLines && (
                  <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                      backgroundImage: `
                        linear-gradient(to right, rgba(0,0,0,0.1) 1px, transparent 1px),
                        linear-gradient(to bottom, rgba(0,0,0,0.1) 1px, transparent 1px)
                      `,
                      backgroundSize: `${magnifierCellSize}px ${magnifierCellSize}px`,
                    }}
                  />
                )}
              </div>
            )}

          </div>
        </div>
      )}

      {/* No-color state hint (when cursor is outside canvas) */}
      {!sampledColor && (
        <div
          className="fixed pointer-events-none"
          style={{
            left: mousePos.x + 16,
            top: mousePos.y + 16,
          }}
        >
          <div className="bg-zinc-900/80 backdrop-blur-sm border border-white/10 rounded-lg px-2.5 py-1.5 shadow-xl">
            <span className={`text-[10px] font-medium ${textColor} text-white/60`}>
              Move to canvas area
            </span>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

export default ColorSampler;
