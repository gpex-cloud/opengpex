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

import React from 'react';
import { SLIDER_THUMB_CSS } from './FancySlider.styles';

// ─── Thumb shape definitions ───────────────────────────────────────────────────

/**
 * CSS `clip-path: polygon(...)` value that clips a rectangular element
 * into the house/pentagon thumb shape.
 */
export const THUMB_CLIP_PATH = `polygon(
  50% 0%,
  100% 28%,
  100% 88%,
  88% 100%,
  12% 100%,
  0% 88%,
  0% 28%
)`;

/**
 * Generate an SVG path `d` attribute for the house-shaped thumb.
 *
 * @param cx - Center x position in the SVG coordinate system
 * @param height - Total height of the thumb in SVG units
 * @param halfWidth - Half-width of the thumb body (default 5)
 * @returns SVG path data string
 */
export function thumbSvgPath(cx: number, height: number, halfWidth = 5): string {
  const roofApexY = 0;
  const roofBaseY = height * 0.28;
  const bodyBottomY = height * 0.78;
  const cornerR = 1;

  return [
    `M ${cx} ${roofApexY}`,
    `L ${cx + halfWidth} ${roofBaseY}`,
    `L ${cx + halfWidth} ${bodyBottomY - cornerR}`,
    `Q ${cx + halfWidth} ${bodyBottomY} ${cx + halfWidth - cornerR} ${bodyBottomY}`,
    `L ${cx - halfWidth + cornerR} ${bodyBottomY}`,
    `Q ${cx - halfWidth} ${bodyBottomY} ${cx - halfWidth} ${bodyBottomY - cornerR}`,
    `L ${cx - halfWidth} ${roofBaseY}`,
    `Z`,
  ].join(' ');
}

/**
 * FancySlider — a styled native `<input type="range">` with custom
 * house-shaped thumb, semantic gradient track, and cross-browser styling.
 *
 * This component encapsulates:
 * - The native `<input type="range">` element (keyboard/ARIA/pointer capture)
 * - The global `<style>` block for custom thumb and track rendering
 * - CSS variable injection for per-instance track gradients
 *
 * It does NOT include label or value display — those are left to the caller
 * for maximum layout flexibility.
 *
 * Usage:
 * ```tsx
 * <FancySlider
 *   value={brightness}
 *   min={0} max={200} step={1}
 *   trackGradient="linear-gradient(90deg, #000 0%, #fff 100%)"
 *   ariaLabel="Brightness"
 *   onDragStart={() => gesture.begin()}
 *   onChange={(v) => patch({ brightness: v })}
 *   onDragEnd={() => gesture.end()}
 * />
 * ```
 */

export interface FancySliderProps {
  /** Current value. */
  value: number;
  /** Minimum value. */
  min: number;
  /** Maximum value. */
  max: number;
  /** Step increment. */
  step: number;
  /** Accessible label for screen readers. */
  ariaLabel: string;
  /**
   * CSS background value for the track. Should be a `linear-gradient(...)` or
   * similar. When omitted, falls back to a neutral stage color.
   */
  trackGradient?: string;
  /**
   * CSS `accent-color` for the track (fallback styling on very old browsers).
   * Optional — default is unset.
   */
  accentColor?: string;
  /** Called on pointerdown (drag start). */
  onDragStart?: () => void;
  /** Called with new value on every change during drag. */
  onChange: (value: number) => void;
  /** Called on pointerup (drag end). */
  onDragEnd?: () => void;
  /** Disabled state. */
  disabled?: boolean;
  /** Additional className for the outer wrapper. */
  className?: string;
}

export default function FancySlider({
  value,
  min,
  max,
  step,
  ariaLabel,
  trackGradient,
  accentColor,
  onDragStart,
  onChange,
  onDragEnd,
  disabled = false,
  className = '',
}: FancySliderProps) {
  const trackBg = trackGradient ?? 'linear-gradient(90deg, var(--bg-stage), var(--bg-stage))';

  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onPointerDown={onDragStart}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onMouseDown={onDragStart}
        onMouseUp={onDragEnd}
        onChange={(e) => {
          const raw = Number.parseFloat(e.target.value);
          if (Number.isFinite(raw)) onChange(raw);
        }}
        style={{
          ['--track-bg' as string]: trackBg,
          ...(accentColor ? { accentColor } : {}),
        }}
        className={`opengpex-basic-slider w-full appearance-none cursor-ew-resize bg-transparent ${className}`}
      />
      {/* Inject global CSS for the custom thumb/track styling. styled-jsx deduplicates. */}
      <style jsx global>{SLIDER_THUMB_CSS}</style>
    </>
  );
}
