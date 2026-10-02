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

import React, { useState, useEffect, useRef } from "react";
import { X, Lightbulb } from "lucide-react";
import { DEFAULT_CONFIG } from "../protocols";
import { useTipRotation } from "../hooks";

// ─── EverydayTips ────────────────────────────────────────────────────────────

export function EverydayTips({
  onDismissForever,
  onDismissSession,
}: {
  onDismissForever: () => void;
  onDismissSession: () => void;
}) {
  const { currentTip, currentIndex, total, advance, goBack } = useTipRotation(DEFAULT_CONFIG.tipRotationInterval);
  const [paused, setPaused] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-rotation with animation
  useEffect(() => {
    if (paused) return;
    timerRef.current = setInterval(() => {
      setIsExiting(true);
      setTimeout(() => {
        advance();
        setIsExiting(false);
      }, 300);
    }, DEFAULT_CONFIG.tipRotationInterval);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [paused, advance]);

  const handleNext = () => {
    setIsExiting(true);
    setTimeout(() => {
      advance();
      setIsExiting(false);
    }, 300);
  };

  const handlePrev = () => {
    setIsExiting(true);
    setTimeout(() => {
      goBack();
      setIsExiting(false);
    }, 300);
  };

  return (
    <div
      className="fixed top-[100px] left-1/2 -translate-x-1/2 pointer-events-auto flex flex-col items-center"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Card container */}
      <div className="relative bg-[var(--bg-panel)]/95 backdrop-blur-xl border border-[var(--border-subtle)] rounded-2xl px-5 py-4 shadow-xl shadow-black/20 w-[380px]">
        {/* Shimmer background animation */}
        <div
          className="absolute inset-0 rounded-2xl opacity-[0.05] overflow-hidden"
          style={{
            background: "linear-gradient(90deg, transparent 0%, #818cf8 50%, transparent 100%)",
            backgroundSize: "200% 100%",
            animation: "shimmer 3s ease-in-out infinite",
          }}
        />

        {/* Top: Tip content area (fixed 2-line height) */}
        <div className="relative flex items-start gap-2.5">
          {/* Lightbulb icon */}
          <Lightbulb size={14} className="flex-shrink-0 text-yellow-400 mt-0.5" />

          {/* Tip text with transition — 2 lines, fixed height */}
          <p
            className={`text-[11.5px] text-[var(--text-main)]/90 leading-[1.7] transition-all duration-300 select-none h-[40px] overflow-hidden line-clamp-2 ${
              isExiting ? "opacity-0 -translate-y-2" : "opacity-100 translate-y-0"
            }`}
          >
            {currentTip.text}
          </p>

          {/* Close button (session dismiss) */}
          <button
            onClick={onDismissSession}
            className="flex-shrink-0 ml-auto w-5 h-5 flex items-center justify-center rounded-full hover:bg-[var(--bg-hover)] transition-colors"
            title="Close for now"
          >
            <X size={11} className="text-[var(--text-muted)]" />
          </button>
        </div>

        {/* Bottom row: prev/next (left) | don't show again (right) */}
        <div className="relative flex items-center justify-between mt-3 pt-2 border-t border-[var(--border-subtle)]/50">
          {/* Left: Prev / Next */}
          <div className="flex items-center gap-3">
            <button
              onClick={handlePrev}
              className="text-[10px] text-[var(--text-muted)] hover:text-indigo-400 transition-colors"
            >
              ← Prev
            </button>
            <button
              onClick={handleNext}
              className="text-[10px] text-[var(--text-muted)] hover:text-indigo-400 transition-colors"
            >
              Next →
            </button>
          </div>

          {/* Right: Don't show again */}
          <button
            onClick={onDismissForever}
            className="text-[9px] text-[var(--text-muted)] hover:text-indigo-400 transition-colors"
            title="Don't show again"
          >
            Don&apos;t show again
          </button>
        </div>
      </div>

      {/* Carousel dot indicators — outside the card */}
      <div className="flex items-center justify-center gap-1 mt-3">
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            className={`h-[3px] rounded-full transition-all duration-300 ${
              i === currentIndex
                ? "w-4 bg-indigo-400"
                : "w-[3px] bg-[var(--text-muted)]/30"
            }`}
          />
        ))}
      </div>

      {/* CSS keyframes */}
      <style>{`
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
      `}</style>
    </div>
  );
}
