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

/**
 * FancySvgSlider — SVG pointer-event based slider.
 *
 * Replaces native `<input type="range">` to avoid the controlled-input feedback
 * loop that causes "Maximum update depth exceeded" in React when using small step
 * values (e.g. step=0.1). See `docs/opengpex/plans/20260804_blur_slider_max_update_depth.md`.
 *
 * Core design:
 * - Pointer events (down/move/up) on an SVG element with setPointerCapture
 * - Value calculated from pointer clientX relative to SVG bounding rect
 * - NO native <input> element — browser cannot re-fire onChange
 * - Built-in NO-OP guard: skips dispatch when snapped value hasn't changed
 * - Optional integrated NumberField (withInput prop)
 * - Keyboard support via onKeyDown (arrow step, Home/End)
 * - ARIA attributes for accessibility (role="slider", aria-valuemin/max/now)
 *
 * Supports CSS gradient track backgrounds via `<foreignObject>` fallback.
 */

import React, { useCallback, useRef } from 'react';
import { NumberField } from '@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/components';

// ─── Constants ──────────────────────────────────────────────────────────────────

/** SVG viewBox width — chosen for clean coordinate math. */
const VB_W = 256;
/** SVG viewBox height. */
const VB_H = 20;
/** Track Y position within viewBox. */
const TRACK_Y = 8;
/** Track height. */
const TRACK_H = 4;
/** Snap-to-center zone in CSS pixels (bipolar mode). Kept minimal to not interfere with dragging. */
const SNAP_PX = 1;

// ─── Types ──────────────────────────────────────────────────────────────────────

/** Bipolar mode configuration for color-per-sign. */
export interface BipolarConfig {
  /** Color used when value < 0. */
  negativeColor: string;
  /** Color used when value >= 0. */
  positiveColor: string;
}

export interface FancySvgSliderProps {
  // ─── Value domain ───
  value: number;
  min: number;
  max: number;
  step: number;

  // ─── Visual ───
  /** CSS gradient string for the track background (e.g. rainbow for Hue). */
  trackGradient?: string;
  /** Accent color for thumb and fill bar. */
  accentColor?: string;
  /** Use compact height for dense panel layouts. */
  slim?: boolean;
  /**
   * Bipolar mode: fill from center (value=0) toward thumb.
   * - `true`: use accentColor for both directions.
   * - `{ negativeColor, positiveColor }`: per-sign colors.
   */
  bipolar?: boolean | BipolarConfig;

  // ─── Integrated NumberField ───
  /** Show a NumberField input to the right of the slider. Default false. */
  withInput?: boolean;
  /** Decimal precision for the NumberField display. */
  precision?: number;

  // ─── Events ───
  /** Called on pointerdown — use for undo checkpoint. */
  onDragStart?: () => void;
  /** Called during drag with the new value. */
  onChange: (value: number) => void;
  /** Called on pointerup — use to close undo checkpoint. */
  onDragEnd?: () => void;
  /** Called when NumberField input is committed (Enter/blur). */
  onFieldCommit?: (value: number) => void;

  // ─── Accessibility ───
  ariaLabel: string;
  disabled?: boolean;
  className?: string;

}

// ─── Component ──────────────────────────────────────────────────────────────────

export default function FancySvgSlider({
  value,
  min,
  max,
  step,
  trackGradient,
  accentColor = '#10b981',
  slim = false,
  bipolar,
  withInput = false,
  precision,
  onDragStart,
  onChange,
  onDragEnd,
  onFieldCommit,
  ariaLabel,
  disabled = false,
  className = '',
}: FancySvgSliderProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef(false);
  const lastCommitted = useRef<number>(value);

  // Derive step precision for snapping
  const stepDecimals = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  const stepMultiplier = Math.pow(10, stepDecimals);

  /** Convert clientX → snapped value in [min, max]. */
  const clientXToValue = useCallback((clientX: number): number => {
    const el = svgRef.current;
    if (!el) return min;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return min;

    // Bipolar: snap to center (value=0) when pointer is within SNAP_PX of zero
    if (bipolar && rect.width > 0) {
      const zeroPx = rect.left + ((0 - min) / (max - min)) * rect.width;
      if (Math.abs(clientX - zeroPx) <= SNAP_PX) return 0;
    }

    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const raw = min + frac * (max - min);
    // Snap to step
    return Math.round(raw * stepMultiplier) / stepMultiplier;
  }, [min, max, stepMultiplier, bipolar]);

  /** Normalized fraction [0, 1] for rendering. */
  const range = max - min;
  const frac = range > 0 ? Math.max(0, Math.min(1, (value - min) / range)) : 0;
  const thumbX = frac * VB_W;

  // ─── Pointer event handlers ───────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    dragRef.current = true;
    onDragStart?.();
    const val = clientXToValue(e.clientX);
    lastCommitted.current = val;
    onChange(val);
  }, [disabled, clientXToValue, onChange, onDragStart]);

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const val = clientXToValue(e.clientX);
    if (val === lastCommitted.current) return; // NO-OP guard
    lastCommitted.current = val;
    onChange(val);
  }, [clientXToValue, onChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = false;
    onDragEnd?.();
  }, [onDragEnd]);

  // ─── Keyboard support ─────────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent<SVGSVGElement>) => {
    if (disabled) return;
    let newValue: number | null = null;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        newValue = Math.min(max, Math.round((value + step) * stepMultiplier) / stepMultiplier);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        newValue = Math.max(min, Math.round((value - step) * stepMultiplier) / stepMultiplier);
        break;
      case 'Home':
        newValue = min;
        break;
      case 'End':
        newValue = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (newValue !== null && newValue !== value) {
      onDragStart?.();
      onChange(newValue);
      onDragEnd?.();
    }
  }, [disabled, value, min, max, step, stepMultiplier, onChange, onDragStart, onDragEnd]);

  // ─── Derived precision for NumberField ────────────────────────────────────

  const fieldPrecision = precision ?? stepDecimals;

  // ─── Bipolar & color logic ────────────────────────────────────────────────

  const isBipolar = !!bipolar;
  const bipolarCfg: BipolarConfig | null =
    bipolar && typeof bipolar === 'object' ? bipolar : null;

  // In bipolar mode, compute the X position of the zero point and per-sign color
  const zeroFrac = isBipolar && range > 0
    ? Math.max(0, Math.min(1, (0 - min) / range))
    : 0;
  const zeroX = zeroFrac * VB_W;

  // Effective fill/thumb color
  let effectiveColor: string;
  if (isBipolar) {
    if (bipolarCfg) {
      effectiveColor = value < 0 ? bipolarCfg.negativeColor : bipolarCfg.positiveColor;
    } else {
      effectiveColor = accentColor;
    }
  } else {
    effectiveColor = accentColor;
  }

  // Fill geometry
  const fillX = isBipolar ? Math.min(thumbX, zeroX) : 0;
  const fillW = isBipolar ? Math.abs(thumbX - zeroX) : thumbX;

  const heightClass = slim ? 'h-4' : 'h-5';

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <div className="flex-1 min-w-0 relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          overflow="visible"
          tabIndex={disabled ? -1 : 0}
          className={`w-full ${heightClass} select-none touch-none outline-none ${
            disabled ? 'cursor-not-allowed opacity-50' : 'cursor-ew-resize'
          }`}
          role="slider"
          aria-label={ariaLabel}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={Math.round(value * stepMultiplier) / stepMultiplier}
          aria-disabled={disabled || undefined}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
        >
          {/* Track background — either gradient via foreignObject or plain rect */}
          {trackGradient ? (
            <foreignObject x={0} y={TRACK_Y} width={VB_W} height={TRACK_H}>
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  borderRadius: '2px',
                  background: trackGradient,
                }}
              />
            </foreignObject>
          ) : (
            <rect
              x={0} y={TRACK_Y} width={VB_W} height={TRACK_H}
              rx={2}
              fill="var(--bg-stage, #374151)"
              fillOpacity={0.5}
            />
          )}

          {/* Bipolar: center marker line at zero */}
          {isBipolar && (
            <line
              x1={zeroX} y1={TRACK_Y - 2}
              x2={zeroX} y2={TRACK_Y + TRACK_H + 2}
              stroke="#71717a"
              strokeOpacity={0.7}
              strokeWidth={0.75}
            />
          )}

          {/* Filled portion — shown when no gradient track, or always in bipolar mode */}
          {(!trackGradient || isBipolar) && (
            <rect
              x={fillX} y={TRACK_Y}
              width={fillW}
              height={TRACK_H}
              rx={2}
              fill={effectiveColor}
              fillOpacity={0.85}
            />
          )}

        </svg>

        {/* Thumb — rendered as HTML div to avoid ellipse distortion from
            preserveAspectRatio="none" on the SVG track. Positioned via left%. */}
        <div
          className="absolute top-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left: `${frac * 100}%` }}
        >
          <div
            className="w-[10px] h-[10px] -ml-[5px] rounded-full"
            style={{
              backgroundColor: effectiveColor,
              border: '1.5px solid var(--text-muted, #d4d4d8)',
            }}
          />
        </div>
      </div>

      {/* Optional integrated NumberField */}
      {withInput && (
        <div className="shrink-0">
          <NumberField
            value={value}
            min={min}
            max={max}
            step={step}
            precision={fieldPrecision}
            disabled={disabled}
            onCommit={onFieldCommit ?? onChange}
            ariaLabel={`${ariaLabel} numeric input`}
          />
        </div>
      )}
    </div>
  );
}
