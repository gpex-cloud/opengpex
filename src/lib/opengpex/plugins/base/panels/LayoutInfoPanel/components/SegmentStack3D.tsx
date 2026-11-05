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
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { RotateCw, Compass, Landmark, Maximize2 } from "lucide-react";
import type { SegmentDefinition } from "../protocols";
import { SEGMENT_COLORS } from "../protocols";

/** Named seat chips shown inside a segment box (label + value). */
export interface SegmentSeat {
  label: string;
  value: number;
  /** Renders with a dagger and a hover note (island / special case) */
  annotated?: string;
  /** Plugin band strip styling */
  band?: boolean;
}

/** Seats per segment, values sourced from EDITOR_Z_INDEX at the call site. */
export interface SegmentSeatMap {
  [segmentId: string]: SegmentSeat[];
}

interface SegmentStack3DProps {
  segmentStack: SegmentDefinition[];
  seatMap: SegmentSeatMap;
  focusedSegment: string | null;
  onFocusSegment: (segmentId: string | null) => void;
}

/** Isometric home view; the reset button returns here. */
const HOME_VIEW = { x: 52, z: -38 };
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;

/** translateZ distance between consecutive segment boxes when exploded. */
const EXPLODE_STEP = 40;
/** Resting (non-hover) fan-out distance. */
const REST_STEP = 22;

export function SegmentStack3D({
  segmentStack,
  seatMap,
  focusedSegment,
  onFocusSegment,
}: SegmentStack3DProps) {
  const [isExploding, setIsExploding] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [rotateAngles, setRotateAngles] = useState(HOME_VIEW);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragTracking = useRef(false);
  const drag3DStart = useRef({ x: 0, y: 0, startPanX: 0, startPanY: 0 });
  const view3DElRef = useRef<HTMLDivElement | null>(null);

  // Pan drag: window-level move/up for smooth tracking; the `isDragging`
  // STATE (not the ref) drives the cursor class so it actually re-renders.
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragTracking.current) return;
      setPanOffset({
        x: drag3DStart.current.startPanX + (e.clientX - drag3DStart.current.x),
        y: drag3DStart.current.startPanY + (e.clientY - drag3DStart.current.y),
      });
    };
    const handleMouseUp = () => {
      dragTracking.current = false;
      setIsDragging(false);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Non-passive wheel: plain scroll zooms, Shift+scroll rotates,
  // Ctrl/Meta+scroll (trackpad pinch) zooms without page zoom.
  const handleWheel3DRef = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    handleWheel3DRef.current = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        setRotateAngles(prev => ({
          x: Math.max(5, Math.min(85, prev.x + e.deltaY * 0.3)),
          z: prev.z + e.deltaX * 0.3,
        }));
      } else {
        const rate = e.ctrlKey || e.metaKey ? 0.01 : 0.005;
        setZoomScale(prev => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev - e.deltaY * rate)));
      }
    };
  });

  const stableWheelHandler = useRef((e: WheelEvent) => {
    handleWheel3DRef.current(e);
  });

  // Safari/WebKit native pinch gestures bypass wheel entirely.
  const gestureStartRef = useRef((e: Event) => e.preventDefault());
  const gestureChangeRef = useRef((e: Event) => {
    e.preventDefault();
    const ge = e as unknown as { scale?: number };
    if (ge.scale !== undefined) {
      setZoomScale(prev => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * ge.scale!)));
    }
  });

  const view3DContainerRef = useCallback((el: HTMLDivElement | null) => {
    if (view3DElRef.current) {
      view3DElRef.current.removeEventListener("wheel", stableWheelHandler.current);
      view3DElRef.current.removeEventListener("gesturestart", gestureStartRef.current);
      view3DElRef.current.removeEventListener("gesturechange", gestureChangeRef.current);
    }
    view3DElRef.current = el;
    if (el) {
      el.addEventListener("wheel", stableWheelHandler.current, { passive: false });
      el.addEventListener("gesturestart", gestureStartRef.current, { passive: false } as AddEventListenerOptions);
      el.addEventListener("gesturechange", gestureChangeRef.current, { passive: false } as AddEventListenerOptions);
    }
  }, []);

  const is3DViewModified =
    zoomScale !== 1 ||
    rotateAngles.x !== HOME_VIEW.x ||
    rotateAngles.z !== HOME_VIEW.z ||
    panOffset.x !== 0 ||
    panOffset.y !== 0;

  const reset3DView = () => {
    setZoomScale(1);
    setRotateAngles(HOME_VIEW);
    setPanOffset({ x: 0, y: 0 });
  };

  const layerOpacity = (segmentId: string, defaultOpacity: number = 1) => {
    if (focusedSegment) return focusedSegment === segmentId ? 1 : 0.18;
    return defaultOpacity;
  };

  return (
    <div className="w-full h-full flex flex-col gap-1.5 min-h-0">
      <div
        ref={view3DContainerRef}
        className={`w-full flex-1 min-h-0 flex items-center justify-center ${
          isDragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        style={{ perspective: "900px", touchAction: "none" }}
        onMouseEnter={() => setIsExploding(true)}
        onMouseLeave={() => setIsExploding(false)}
        onDoubleClick={e => {
          e.stopPropagation();
          reset3DView();
        }}
        onMouseDown={e => {
          if (e.button !== 0) return;
          const target = e.target as HTMLElement;
          if (target.closest("button")) return;
          e.stopPropagation();
          e.preventDefault();
          dragTracking.current = true;
          setIsDragging(true);
          drag3DStart.current = {
            x: e.clientX,
            y: e.clientY,
            startPanX: panOffset.x,
            startPanY: panOffset.y,
          };
        }}
      >
        <div style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px)` }}>
          <div
            className="relative w-72 h-52 transition-transform duration-500 ease-out"
            style={{
              transform: `rotateX(${rotateAngles.x}deg) rotateZ(${rotateAngles.z}deg) scale(${zoomScale})`,
              transformStyle: "preserve-3d",
            }}
          >
            {segmentStack.map((segment, index) => {
              const colors = SEGMENT_COLORS[segment.color] ?? SEGMENT_COLORS.emerald;
              const isFocused = focusedSegment === segment.id;
              const restZ = index * REST_STEP;
              const explodeZ = index * EXPLODE_STEP;
              const seats = seatMap[segment.id] ?? [];

              return (
                <div
                  key={segment.id}
                  onClick={e => {
                    e.stopPropagation();
                    onFocusSegment(isFocused ? null : segment.id);
                  }}
                  className={`absolute inset-0 rounded-2xl border-2 flex flex-col items-center justify-center gap-1 font-mono text-[8px] transition-all duration-500 ease-out cursor-pointer ${colors.tint} ${
                    isFocused ? `${colors.focusBorder} ring-1` : colors.border
                  }`}
                  style={{
                    transform: `translateZ(${isExploding ? explodeZ : restZ}px)`,
                    opacity: layerOpacity(segment.id, 1),
                    boxShadow: isFocused ? "0 10px 30px rgba(0,0,0,0.25)" : "none",
                  }}
                >
                  {/* Segment header chip */}
                  <div
                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-[7px] font-black uppercase tracking-widest ${colors.chip} border border-current/20`}
                    title={segment.note}
                  >
                    <span className="font-mono">{segment.level}</span>
                    <span>{segment.name}</span>
                    <span className="opacity-60">base {segment.base}</span>
                    {segment.portalRootId && (
                      <span className="inline-flex items-center gap-0.5 opacity-80" title={`Island root: #${segment.portalRootId}`}>
                        <Landmark size={7} />
                        island
                      </span>
                    )}
                  </div>

                  {/* Island interior frame + seats */}
                  {segment.portalRootId && (
                    <div className="absolute inset-3 rounded-xl border border-dashed border-[var(--border-subtle)] pointer-events-none" />
                  )}
                  <div className="flex flex-wrap items-center justify-center gap-1 px-3 max-w-full relative z-10">
                    {seats.map(seat => (
                      <span
                        key={seat.label}
                        title={seat.annotated}
                        className={`px-1.5 py-0.5 rounded text-[6.5px] font-black uppercase tracking-tight ${
                          seat.band
                            ? "bg-[var(--bg-stage)] border border-dashed border-[var(--border-subtle)] text-[var(--text-muted)]"
                            : colors.chip
                        }`}
                      >
                        {seat.annotated ? `${seat.label} †` : seat.label} {seat.value}
                      </span>
                    ))}
                    {seats.length === 0 && (
                      <span className="text-[6px] text-[var(--text-muted)] uppercase opacity-60">
                        no named seats
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {/* ROOT_OVERLAY annotation card — outside the stack: the slot
                container itself has z auto (level 0), floating content enters
                the matrix only through portal roots. */}
            <div
              className="absolute -bottom-7 -right-6 flex items-center gap-1 px-2 py-1 rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-stage)] text-[6.5px] font-black uppercase tracking-wider text-[var(--text-muted)] cursor-help"
              title="ROOT_OVERLAY mounts at z-index auto (level 0). Its floating content reaches the matrix only through the portal segment roots."
            >
              <Maximize2 size={8} />
              ROOT_OVERLAY · z auto → portal
            </div>
          </div>
        </div>
      </div>

      {/* Segment focus selector — one chip per segment, colour classes come
          from the full-name table so Tailwind can generate them. */}
      <div className="flex items-center gap-1 flex-wrap flex-shrink-0">
        {segmentStack.map(segment => {
          const colors = SEGMENT_COLORS[segment.color] ?? SEGMENT_COLORS.emerald;
          const isFocused = focusedSegment === segment.id;
          const isDimmed = focusedSegment !== null && !isFocused;
          return (
            <button
              key={segment.id}
              title={`${segment.name} · base ${segment.base}${segment.note ? `\n${segment.note}` : ""}`}
              onClick={e => {
                e.stopPropagation();
                onFocusSegment(isFocused ? null : segment.id);
              }}
              className={`px-1.5 py-0.5 rounded-md border text-[7px] font-black uppercase tracking-tight transition-all duration-200 outline-none cursor-pointer ${
                isFocused
                  ? `${colors.focusBg} ${colors.focusBorder} text-white shadow`
                  : isDimmed
                    ? "bg-[var(--bg-stage)]/50 text-[var(--text-muted)] border-transparent opacity-50"
                    : `bg-[var(--bg-panel)] text-[var(--text-main)] border-[var(--border-subtle)] ${colors.hoverBorder}`
              }`}
            >
              {segment.level}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between flex-shrink-0">
        <div className="text-[7px] font-black text-[var(--text-muted)] uppercase tracking-wide leading-none flex items-center gap-1">
          <Compass size={8} />
          Drag: pan · Scroll: zoom · ⇧Scroll: rotate · DblClick: reset · Click: focus
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[7px] font-black text-[var(--text-muted)] tabular-nums font-mono">
            {Math.round(zoomScale * 100)}%
          </span>
          <span className="text-[6px] font-mono text-[var(--text-muted)] tabular-nums">
            X:{Math.round(rotateAngles.x)}° Z:{Math.round(rotateAngles.z)}°
          </span>
          {is3DViewModified && (
            <button
              onClick={reset3DView}
              className="text-[7px] font-black text-indigo-500 uppercase hover:underline cursor-pointer flex items-center gap-0.5"
            >
              <RotateCw size={7} />
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
