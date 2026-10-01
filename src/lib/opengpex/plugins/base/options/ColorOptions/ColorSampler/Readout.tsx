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

import { rgbToHex, gridLineWidth } from "./helpers";
import type { Rgb, GridInk } from "./types";

interface SampleReadoutProps {
  /** Cursor position (viewport-relative) the capsule anchors to. */
  mousePos: { x: number; y: number };
  /** Actual image pixel coordinate (X, Y) corresponding to the document image. */
  pixelPos?: { x: number; y: number } | null;
  /** The magnifier's grid cells (row-major, 8-bit display track). */
  magnifierPixels: Rgb[];
  /** Two-tone divider greys for the current block. */
  gridInk: GridInk | null;
  currentLayerOnly: boolean;
  showMagnifier: boolean;
  showGridLines: boolean;
  magnifierCellSize: number;
  magnifierGridSize: number;
}

/**
 * The floating pixel magnifier shown WHILE A PICK IS HELD (Photoshop-aligned):
 * displays the pixel magnifier grid (9×9) with central cell highlight, contrast
 * dividers, and document pixel coordinate (X, Y).
 */
export function SampleReadout({
  mousePos,
  pixelPos,
  magnifierPixels,
  gridInk,
  currentLayerOnly,
  showMagnifier,
  showGridLines,
  magnifierCellSize,
  magnifierGridSize,
}: SampleReadoutProps) {
  if (!showMagnifier || magnifierPixels.length === 0) return null;

  // Calculate tooltip position (offset from cursor to avoid overlap)
  const tooltipOffset = 20;
  const magnifierW = magnifierGridSize * magnifierCellSize;
  const capsuleW = magnifierW;
  const tooltipOuterW = capsuleW + 14;
  const tooltipOuterH = magnifierW + (pixelPos ? 22 : 0) + (currentLayerOnly ? 20 : 0) + 14;

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

  return (
    <div
      className="fixed pointer-events-none animate-in fade-in duration-100"
      style={{
        left: tooltipX,
        top: tooltipY,
      }}
    >
      <div
        className="flex flex-col gap-1 bg-zinc-900/90 backdrop-blur-xl border border-white/10 rounded-xl p-1.5 shadow-2xl"
        style={{ width: tooltipOuterW }}
      >
        {/* Magnifier Grid */}
        <div
          className="rounded-lg overflow-hidden relative shrink-0"
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
              const mid = Math.floor(magnifierGridSize / 2);
              const isCenter =
                i % magnifierGridSize === mid &&
                ((i / magnifierGridSize) | 0) === mid;
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

          {/* Two-tone dividers (see gridInkFor). INTERIOR boundaries only. */}
          {showGridLines && gridInk &&
            (() => {
              const w = gridLineWidth();
              return Array.from({ length: magnifierGridSize - 1 }).flatMap((_, k) => {
                const p = (k + 1) * magnifierCellSize - w / 2;
                return [
                  <div
                    key={`v${k}`}
                    className="absolute pointer-events-none"
                    style={{
                      left: p, top: 0, width: w, height: "100%",
                      backgroundImage: `linear-gradient(to right, ${gridInk.lo} 50%, ${gridInk.hi} 50%)`,
                    }}
                  />,
                  <div
                    key={`h${k}`}
                    className="absolute pointer-events-none"
                    style={{
                      top: p, left: 0, height: w, width: "100%",
                      backgroundImage: `linear-gradient(to bottom, ${gridInk.lo} 50%, ${gridInk.hi} 50%)`,
                    }}
                  />,
                ];
              });
            })()}
        </div>

        {/* Document Pixel Coordinates (X, Y) */}
        {pixelPos && (
          <div className="flex items-center justify-between px-1 pt-0.5 text-[10px] font-mono font-bold tabular-nums text-white/90 select-none">
            <span>X: {pixelPos.x}</span>
            <span>Y: {pixelPos.y}</span>
          </div>
        )}

        {/* Current layer badge */}
        {currentLayerOnly && (
          <div className="flex justify-center pt-0.5">
            <span className="text-[9px] font-mono font-semibold uppercase tracking-wide text-amber-400">
              current layer
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The "Capturing…" hint shown while a press is in flight and the snapshot has
 * not landed yet. Before a press we deliberately show no colour (PS point
 * sample), and off-image there is no chrome — so no "move to canvas" prompt.
 */
export function CapturingHint({ x, y }: { x: number; y: number }) {
  return (
    <div
      className="fixed pointer-events-none"
      style={{
        left: x + 16,
        top: y + 16,
      }}
    >
      <div className="bg-zinc-900/80 backdrop-blur-sm border border-white/10 rounded-lg px-2.5 py-1.5 shadow-xl">
        <span className="text-[10px] font-medium text-white/60">
          Capturing…
        </span>
      </div>
    </div>
  );
}
