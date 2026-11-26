/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the GNU General Public License.
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
 * AngleDial — one-gesture direction + distance control (A8 P5): drag anywhere
 * on the dial and the handle lands in that direction at that distance, so a
 * drop shadow's offset is ONE motion instead of two numeric fields.
 *
 * COORDINATE CONTRACT: the emitted offset is CANVAS px (positive y = DOWN,
 * matching `ShadowParams.offsetX/offsetY` and every render-side consumer) —
 * screen dy already points down, so no sign flip happens anywhere. The pure
 * conversions are exported for golden tests; the dial widget itself is a thin
 * pointer surface over them.
 */

import React, { useCallback, useRef, useState } from 'react';

/** Hard clamp on the dial's distance, in canvas px (drives the ROI window). */
export const ANGLE_DIAL_MAX_DISTANCE_PX = 250;

/**
 * Polar → cartesian in canvas px: `angleDeg` 0° = right, growing CLOCKWISE
 * (screen convention, positive y down — 45° casts down-right), `distance`
 * clamped to {@link ANGLE_DIAL_MAX_DISTANCE_PX}.
 */
export function offsetFromAngleDistance(angleDeg: number, distance: number): { x: number; y: number } {
  const d = Number.isFinite(distance) ? Math.min(ANGLE_DIAL_MAX_DISTANCE_PX, Math.max(0, distance)) : 0;
  const rad = (Number.isFinite(angleDeg) ? angleDeg : 0) * (Math.PI / 180);
  return { x: Math.cos(rad) * d, y: Math.sin(rad) * d };
}

/** Cartesian → polar, the exact inverse: clockwise degrees + clamped distance. */
export function angleDistanceFromOffset(x: number, y: number): { angleDeg: number; distance: number } {
  const raw = Math.hypot(x, y);
  // Non-finite offsets (a corrupted param can carry NaN/∞) collapse to zero —
  // the dial must never receive or display NaN.
  const dist = Number.isFinite(raw) ? Math.min(ANGLE_DIAL_MAX_DISTANCE_PX, raw) : 0;
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (!Number.isFinite(deg)) deg = 0;
  return { angleDeg: deg, distance: dist };
}

interface AngleDialProps {
  /** Current offset in canvas px (positive y = down). */
  offsetX: number;
  offsetY: number;
  /** Live drag channel (fires on every pointer move). */
  onChange: (x: number, y: number) => void;
  /** Gesture boundary: ONE pointerdown → onChange… → pointerup. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Rendered diameter in px (default 64). Pointer math and the handle
      position scale with it — the 250 px offset range always fits. */
  size?: number;
}

const DEFAULT_DIAL_SIZE = 64;
const HANDLE_RADIUS = 5;
/** Visual padding so the handle at max distance stays inside the dial. */
const DIAL_INSET = HANDLE_RADIUS + 2;

export default function AngleDial({
  offsetX,
  offsetY,
  onChange,
  onDragStart,
  onDragEnd,
  disabled = false,
  className = '',
  ariaLabel = 'Shadow direction and distance',
  size = DEFAULT_DIAL_SIZE,
}: AngleDialProps) {
  const dialRadius = size / 2;
  const ref = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  // Fast-drag mirror: while a gesture runs the store is frozen, so the knob
  // feeds from local state (the same pattern as FancySvgSlider's drag).
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const shown = dragOffset ?? { x: offsetX, y: offsetY };

  const pointerToOffset = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const el = ref.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // Dial-local px → offset px: the usable visual radius maps linearly onto
    // [0, MAX_DISTANCE].
    const usable = dialRadius - DIAL_INSET;
    const dx = (clientX - cx) * (ANGLE_DIAL_MAX_DISTANCE_PX / usable);
    const dy = (clientY - cy) * (ANGLE_DIAL_MAX_DISTANCE_PX / usable);
    const { angleDeg, distance } = angleDistanceFromOffset(dx, dy);
    return offsetFromAngleDistance(angleDeg, distance);
  }, [dialRadius]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    onDragStart?.();
    const next = pointerToOffset(e.clientX, e.clientY);
    setDragOffset(next);
    onChange(next.x, next.y);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current || disabled) return;
    const next = pointerToOffset(e.clientX, e.clientY);
    setDragOffset(next);
    onChange(next.x, next.y);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Capture may already be gone (pointercancel racing pointerup) — the
      // gesture bookkeeping below is what matters, not the release.
    }
    onDragEnd?.();
    setDragOffset(null);
  };

  // Handle placement: canvas offset → dial-local visual px (inverse of the
  // pointer mapping — usable radius spans [0, MAX_DISTANCE]).
  const usable = dialRadius - DIAL_INSET;
  const hx = dialRadius + (shown.x / ANGLE_DIAL_MAX_DISTANCE_PX) * usable;
  const hy = dialRadius + (shown.y / ANGLE_DIAL_MAX_DISTANCE_PX) * usable;
  const dist = Math.hypot(shown.x, shown.y);

  return (
    <div
      ref={ref}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={ANGLE_DIAL_MAX_DISTANCE_PX}
      aria-valuenow={Math.round(dist)}
      aria-valuetext={`${Math.round(dist)} px at ${Math.round(angleDistanceFromOffset(shown.x, shown.y).angleDeg)} degrees`}
      aria-disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={`relative select-none touch-none rounded-full border border-[var(--border-subtle)] bg-[var(--bg-stage)] shadow-inner ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-crosshair'} ${className}`}
      style={{ width: size, height: size }}
    >
      {/* Crosshair guides */}
      <div className="absolute left-1/2 top-1.5 bottom-1.5 w-px -translate-x-1/2 bg-[var(--border-subtle)]" />
      <div className="absolute top-1/2 left-1.5 right-1.5 h-px -translate-y-1/2 bg-[var(--border-subtle)]" />
      {/* Center origin dot */}
      <div className="absolute left-1/2 top-1/2 w-1 h-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--text-muted)]" />
      {/* Handle (sits at the CENTER when distance is 0) */}
      <div
        className="absolute w-[10px] h-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-500 shadow-sm ring-1 ring-black/20 dark:ring-white/20"
        style={{ left: hx, top: hy }}
      />
    </div>
  );
}
