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
 * AngleDial — one-gesture direction + distance control (A8 P5): drag anywhere
 * on the dial and the handle follows, so a drop shadow's offset is ONE motion
 * instead of two numeric fields.
 *
 * COORDINATE CONTRACT: the emitted offset is CANVAS px (positive y = DOWN,
 * matching `ShadowParams.offsetX/offsetY` and every render-side consumer) —
 * screen dy already points down, so no sign flip happens anywhere. The pure
 * conversions are exported for golden tests; the dial widget itself is a thin
 * pointer surface over them.
 *
 * EXPAND-ON-PRESS (20261128): the resting dial is small (drawer rail real
 * estate), but the offset range is large (250 px) — mapping the full range
 * onto the small face makes fine control impossible. Pressing the dial
 * spawns an enlarged floating dial (portal, centered on the resting dial's
 * position) for the duration of the gesture; releasing dismisses it.
 *
 * MAPPING = ABSOLUTE against the expanded dial's fixed center (user ruling
 * 20261128): the dial opens at the resting dial's position and the ball
 * snaps to / follows the pointer 1:1; the dashed marker marks where the
 * offset WAS, so the press-time snap reads as intended. Holding Shift
 * engages fine mode: only 1/10 of each move's incremental delta applies
 * (engaging Shift mid-gesture never jumps the value). The gesture has
 * unlimited travel — dragging past the dial edge keeps the ball clamped at
 * the rim while the value saturates.
 */

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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

/** Clamp a raw offset to the dial's distance envelope (keeps angle, trims length). */
function clampOffset(x: number, y: number): { x: number; y: number } {
  const { angleDeg, distance } = angleDistanceFromOffset(x, y);
  return offsetFromAngleDistance(angleDeg, distance);
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
  /** Rendered diameter in px (default 64). The 250 px offset range always
      fits; fine control comes from the expand-on-press floating dial. */
  size?: number;
  /** Expanded-dial visibility notifier: the caller's inline Distance/Angle
      readout hides while the expanded dial (which carries its own live
      badge) is open. */
  onExpandedChange?: (open: boolean) => void;
}

const DEFAULT_DIAL_SIZE = 64;
/** The press-expanded floating dial's diameter (the magnified gesture view). */
const EXPANDED_DIAL_SIZE = 200;
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
  onExpandedChange,
}: AngleDialProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  // Press origin for the RELATIVE mapping: the pointer's screen position at
  // pointerdown and the offset at that moment (v0).
  const pressRef = useRef<{ px: number; py: number; startX: number; startY: number } | null>(null);
  // Fast-drag mirror: while a gesture runs the store is frozen, so the knob
  // feeds from local state (the same pattern as FancySvgSlider's drag).
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  // The expanded dial's anchor, computed once at pointerdown so the gesture
  // math has a stable center: center = pressPoint − v0·(usableBig/250).
  // Consequence: at press the pointer sits EXACTLY on the v0 handle, and the
  // ABSOLUTE mapping (pointer − center) reproduces v0 with no jump while
  // keeping pointer == handle 1:1 for the whole gesture. A layout shift
  // mid-gesture cannot move the anchor.
  const expandedRef = useRef<{ cx: number; cy: number } | null>(null);
  // Last EMITTED raw offset (Shift-fine-mode's incremental base; reset at
  // gesture boundaries so a new press never inherits stale deltas).
  const lastRawRef = useRef<{ x: number; y: number } | null>(null);
  // rAF coalescing: high-report-rate mice fire pointermove far above the
  // display refresh rate; processing each event means React re-renders and
  // volatile writes (each folding a WebGPU frame) at event rate — Chrome/macOS
  // flag the page as a high-power consumer. Only the LATEST event per frame
  // is processed; intermediate ones collapse.
  const rafRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ clientX: number; clientY: number; shiftKey: boolean } | null>(null);
  const processMoveRef = useRef<((ev: { clientX: number; clientY: number; shiftKey: boolean }) => void) | null>(null);
  const [expanded, setExpanded] = useState<{ cx: number; cy: number; startX: number; startY: number } | null>(null);
  const shown = dragOffset ?? { x: offsetX, y: offsetY };

  // RELATIVE mapping: v0 + pointer delta × gain (Shift = 1/10 fine mode),
  // clamped to the distance envelope. The pointer's absolute position — and
  // therefore its alignment with the floating dial — plays no part.
  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    // The expanded dial opens FIXED and CONCENTRIC with the resting dial
    // (20261128 ruling) — it does not chase the pointer: the ball snaps to
    // the pointer for the whole gesture (absolute mapping, see
    // handlePointerMove), and the indigo marker shows where the offset WAS,
    // so the snap reads as intended.
    const press = { px: e.clientX, py: e.clientY, startX: offsetX, startY: offsetY };
    pressRef.current = press;
    const el = ref.current;
    if (el) {
      // 同心 (20261128 ruling): the expanded dial opens concentric with the
      // resting dial — same center, bigger face.
      const rect = el.getBoundingClientRect();
      const center = { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
      expandedRef.current = center;
      setExpanded({ ...center, startX: press.startX, startY: press.startY });
      onExpandedChange?.(true);
    }
    onDragStart?.();
    // Absolute semantics: the ball is under the pointer from the first
    // frame — emit the pressed position as the new offset.
    const center0 = expandedRef.current;
    if (center0) {
      const usableBig = EXPANDED_DIAL_SIZE / 2 - DIAL_INSET;
      const scale = usableBig / ANGLE_DIAL_MAX_DISTANCE_PX;
      const next = clampOffset(
        (e.clientX - center0.cx) / scale,
        (e.clientY - center0.cy) / scale,
      );
      lastRawRef.current = next;
      setDragOffset(next);
      onChange(next.x, next.y);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current || disabled) return;
    // Park the event and schedule one rAF — the latest input wins.
    pendingMoveRef.current = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey };
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const ev = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (ev) processMoveRef.current?.(ev);
    });
  };

  const processMove = (ev: { clientX: number; clientY: number; shiftKey: boolean }) => {
    if (!draggingRef.current || disabled) return;
    const anchor = expandedRef.current;
    if (!anchor) return;
    // ABSOLUTE mapping against the fixed center: pointer position == ball
    // position (1:1 after the face scale). Shift = fine mode: only 1/10 of
    // each move's raw delta applies (incremental — engaging Shift mid-gesture
    // never jumps the value).
    const usableBig = EXPANDED_DIAL_SIZE / 2 - DIAL_INSET;
    const scale = usableBig / ANGLE_DIAL_MAX_DISTANCE_PX;
    const raw = clampOffset(
      (ev.clientX - anchor.cx) / scale,
      (ev.clientY - anchor.cy) / scale,
    );
    const last = lastRawRef.current;
    const gain = ev.shiftKey ? 0.1 : 1;
    const next = last
      ? clampOffset(last.x + (raw.x - last.x) * gain, last.y + (raw.y - last.y) * gain)
      : raw;
    lastRawRef.current = next;
    setDragOffset(next);
    onChange(next.x, next.y);
  };
  useLayoutEffect(() => {
    processMoveRef.current = processMove;
  });

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    pressRef.current = null;
    expandedRef.current = null;
    lastRawRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingMoveRef.current = null;
    setExpanded(null);
    onExpandedChange?.(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Capture may already be gone (pointercancel racing pointerup) — the
      // gesture bookkeeping below is what matters, not the release.
    }
    onDragEnd?.();
    setDragOffset(null);
  };

  // Dial face: canvas offset → dial-local visual px (usable radius spans
  // [0, MAX_DISTANCE]). Shared by the resting dial and the expanded dial.
  const renderDialFace = useCallback((
    faceSize: number,
    faceOffset: { x: number; y: number },
    opts: { /** The pre-gesture offset position (a solid indigo marker on the expanded dial). */
      startMarker?: { x: number; y: number } | null;
      /** Crosshair guides (kept on the resting dial; the expanded dial drops
          them — the handle itself is the aiming point). */
      crosshair?: boolean;
      /** Handle fill (the expanded dial's live handle reads red against the
          indigo origin marker). */
      handleColor?: string;
    } = {},
  ) => {
    const r = faceSize / 2;
    const usableFace = r - DIAL_INSET;
    const hx = r + (faceOffset.x / ANGLE_DIAL_MAX_DISTANCE_PX) * usableFace;
    const hy = r + (faceOffset.y / ANGLE_DIAL_MAX_DISTANCE_PX) * usableFace;
    return (
      <>
        {/* Crosshair guides (both faces) */}
        {opts.crosshair !== false && (
          <>
            <div className="absolute left-1/2 top-1.5 bottom-1.5 w-px -translate-x-1/2 bg-[var(--border-subtle)]" />
            <div className="absolute top-1/2 left-1.5 right-1.5 h-px -translate-y-1/2 bg-[var(--border-subtle)]" />
          </>
        )}
        {/* Center origin dot: ALWAYS visible, rendered ABOVE the crosshair
            lines (the ball needs a center to read against). */}
        <div className="absolute left-1/2 top-1/2 w-1 h-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--text-muted)]" />
        {/* Gesture origin marker (expanded dial only): the pre-gesture offset
            position, in the same indigo as the resting handle. */}
        {opts.startMarker && (
          <div
            className="absolute w-[10px] h-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-500/40 ring-1 ring-indigo-400/60"
            style={{
              left: r + (opts.startMarker.x / ANGLE_DIAL_MAX_DISTANCE_PX) * usableFace,
              top: r + (opts.startMarker.y / ANGLE_DIAL_MAX_DISTANCE_PX) * usableFace,
            }}
          />
        )}
        {/* Handle (sits at the CENTER when distance is 0) */}
        <div
          className="absolute w-[10px] h-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full shadow-sm ring-1 ring-black/20 dark:ring-white/20"
          style={{ left: hx, top: hy, background: opts.handleColor ?? 'rgb(99 102 241)' }}
        />
      </>
    );
  }, []);

  // Portal mount guard: the expanded dial only ever mounts from a pointer
  // gesture (client-only), but the document-body check keeps the portal call
  // honest without a setState-in-effect.
  const portalReady = typeof document !== 'undefined';

  const dist = Math.hypot(shown.x, shown.y);
  const polar = angleDistanceFromOffset(shown.x, shown.y);

  return (
    <>
      <div
        ref={ref}
        role="slider"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={ANGLE_DIAL_MAX_DISTANCE_PX}
        aria-valuenow={Math.round(dist)}
        aria-valuetext={`${Math.round(dist)} px at ${Math.round(polar.angleDeg)} degrees`}
        aria-disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className={`relative select-none touch-none rounded-full border border-[var(--border-subtle)] bg-[var(--bg-stage)] shadow-inner ${disabled ? 'opacity-40 cursor-not-allowed' : dragOffset ? 'cursor-none' : 'cursor-crosshair'} ${className}`}
        style={{ width: size, height: size }}
      >
        {renderDialFace(size, shown, { crosshair: true })}
      </div>
      {/* Expanded floating dial: pure VIEW (pointer-events-none — the pointer
          capture lives on the resting dial, so the gesture never depends on
          what the pointer is over). Centered on the resting dial's captured
          screen position. */}
      {expanded && portalReady && createPortal(
        <div
          className="fixed z-[1000] pointer-events-none select-none"
          style={{
            left: expanded.cx - EXPANDED_DIAL_SIZE / 2,
            top: expanded.cy - EXPANDED_DIAL_SIZE / 2,
            width: EXPANDED_DIAL_SIZE,
            height: EXPANDED_DIAL_SIZE,
          }}
        >
          {/* Live readout: a badge on the 45° NE diagonal, just outside the
              rim (centered on that diagonal point) — opaque gray with white
              text for contrast on both themes. */}
          <div
            className="absolute z-10 px-2 py-0.5 rounded-md bg-zinc-700 text-white text-[10px] font-bold tabular-nums whitespace-nowrap shadow-md"
            style={{
              // Anchored by its LEFT edge on the diagonal point: the badge
              // grows rightward, fully clear of the circle.
              left: EXPANDED_DIAL_SIZE / 2 + (EXPANDED_DIAL_SIZE / 2 + 10) * Math.SQRT1_2,
              top: EXPANDED_DIAL_SIZE / 2 - (EXPANDED_DIAL_SIZE / 2 + 10) * Math.SQRT1_2,
              transform: 'translateY(-50%)',
            }}
          >
            {Math.round(polar.distance)} px · {Math.round(polar.angleDeg)}°
          </div>
          <div className="relative w-full h-full rounded-full border border-[var(--border-light)] bg-[var(--bg-stage)] shadow-lg">
            {renderDialFace(EXPANDED_DIAL_SIZE, shown, {
              startMarker: { x: expanded.startX, y: expanded.startY },
              crosshair: true,
              handleColor: 'rgb(239 68 68)',
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
