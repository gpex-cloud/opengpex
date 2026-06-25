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

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useEditorState } from "@opengpex/editor/core/context";
import { useOnboarding, useTipRotation } from "./hooks";
import { DEFAULT_CONFIG, type SpotlightDef, type SpotlightPosition } from "./protocols";
import { X, Sparkles, Lightbulb } from "lucide-react";

/**
 * OnboardingComponent: ROOT_OVERLAY plugin component.
 * Renders SpotlightBubble and EverydayTips directly in Window space.
 * Full-screen pointer-events-none container; individual elements opt-in to interaction.
 */
export function OnboardingComponent() {
  const { state } = useEditorState();
  const hasFrames = state.frames.order.length > 0;
  const trigger = hasFrames ? "has-frame" : "no-frame";

  const onboarding = useOnboarding(trigger);

  return (
    <div
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 5500 }}
    >
      {/* SpotlightBubble: show only when we have an active spotlight */}
      {onboarding.activeSpotlight && (
        <SpotlightBubble
          spotlight={onboarding.activeSpotlight}
          messageIndex={onboarding.currentMessageIndex}
          onAdvance={onboarding.advanceOrDismissSpotlight}
          onDismiss={onboarding.dismissSpotlight}
          onDismissForever={onboarding.dismissSpotlightForever}
        />
      )}

      {/* EverydayTips: only when frames are loaded and tips enabled */}
      {hasFrames && onboarding.tipsEnabled && (
        <EverydayTips
          onDismissForever={onboarding.dismissTipsForever}
          onDismissSession={onboarding.dismissTipsSession}
        />
      )}
    </div>
  );
}

// ─── SpotlightBubble ────────────────────────────────────────────────────────

/**
 * Generic target element locator.
 * Uses spotlight.target selector, optionally drills into spotlight.targetChild.
 */
function findTargetElement(spotlight: SpotlightDef): DOMRect | null {
  const container = document.querySelector(spotlight.target);
  if (!container) return null;
  if (spotlight.targetChild) {
    const child = container.querySelector(spotlight.targetChild);
    if (child) return child.getBoundingClientRect();
  }
  return container.getBoundingClientRect();
}

/**
 * Compute bubble position based on target rect and desired position.
 * Returns CSS properties for the bubble container.
 */
function computeBubblePosition(
  rect: DOMRect,
  position: SpotlightPosition,
): React.CSSProperties {
  const gap = 12;
  const arrowOffset = 16; // arrow distance from bubble edge

  switch (position) {
    case "left":
      return {
        right: `${window.innerWidth - rect.left + gap}px`,
        top: `${rect.top + rect.height / 2 - arrowOffset}px`,
      };
    case "right":
      return {
        left: `${rect.right + gap}px`,
        top: `${rect.top + rect.height / 2 - arrowOffset}px`,
      };
    case "top":
      return {
        left: `${rect.left + rect.width / 2}px`,
        bottom: `${window.innerHeight - rect.top + gap}px`,
        transform: "translateX(-50%)",
      };
    case "bottom":
      return {
        left: `${rect.left + rect.width / 2}px`,
        top: `${rect.bottom + gap}px`,
        transform: "translateX(-50%)",
      };
  }
}

/** Arrow CSS classes for each position */
const ARROW_CLASSES: Record<SpotlightPosition, string> = {
  left: "absolute top-4 -right-[7px] w-3.5 h-3.5 rotate-45 bg-[var(--bg-panel)] border-r border-t border-[var(--border-subtle)]",
  right: "absolute top-4 -left-[7px] w-3.5 h-3.5 rotate-45 bg-[var(--bg-panel)] border-l border-b border-[var(--border-subtle)]",
  top: "absolute -bottom-[7px] left-1/2 -translate-x-1/2 w-3.5 h-3.5 rotate-45 bg-[var(--bg-panel)] border-r border-b border-[var(--border-subtle)]",
  bottom: "absolute -top-[7px] left-1/2 -translate-x-1/2 w-3.5 h-3.5 rotate-45 bg-[var(--bg-panel)] border-l border-t border-[var(--border-subtle)]",
};

/**
 * Check if any drawer panel is currently expanded (DOM-based detection).
 * Looks for wide panel elements (> 100px) inside the drawer bar containers.
 */
function isAnyDrawerExpanded(): boolean {
  const bars = document.querySelectorAll("[data-drawer-bar]");
  for (const bar of bars) {
    // When a panel is expanded, AnimatePresence renders a wide panel element
    // that is significantly wider than the collapsed icon (40px)
    const wideElements = bar.querySelectorAll('[style*="width"]');
    for (const el of wideElements) {
      const style = (el as HTMLElement).style;
      const width = parseInt(style.width, 10);
      if (width > 100) return true;
    }
  }
  return false;
}

function SpotlightBubble({
  spotlight,
  onDismiss,
  onDismissForever,
}: {
  spotlight: SpotlightDef;
  messageIndex: number;
  onAdvance: (id: string) => void;
  onDismiss: (id: string) => void;
  onDismissForever: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [posStyle, setPosStyle] = useState<React.CSSProperties | null>(null);

  const currentMessage = spotlight.messages[0];

  // Generic target locator
  const locateTarget = useCallback(() => {
    const rect = findTargetElement(spotlight);
    if (rect) {
      setPosStyle(computeBubblePosition(rect, spotlight.position));
    } else {
      // Fallback position
      setPosStyle({ right: "68px", top: "82px" });
    }
  }, [spotlight]);

  // Delayed entrance
  useEffect(() => {
    const timer = setTimeout(() => {
      locateTarget();
      setVisible(true);
    }, DEFAULT_CONFIG.spotlightDelay);
    return () => clearTimeout(timer);
  }, [locateTarget]);

  // Re-locate on resize
  useEffect(() => {
    if (!visible) return;
    const handleResize = () => locateTarget();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [visible, locateTarget]);

  // Hide when any drawer panel is expanded AND re-locate when drawer shifts
  // (e.g. XTEND_SLOT resize pushes drawer icons down)
  useEffect(() => {
    if (!visible) return;
    const check = () => {
      setHidden(isAnyDrawerExpanded());
      locateTarget();
    };
    check(); // initial check
    const observer = new MutationObserver(check);
    const bars = document.querySelectorAll("[data-drawer-bar]");
    bars.forEach((bar) =>
      observer.observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] }),
    );
    return () => observer.disconnect();
  }, [visible, locateTarget]);

  if (!visible || !posStyle || hidden) return null;

  return (
    <div
      className="fixed pointer-events-auto"
      style={posStyle}
    >
      {/* Card */}
      <div className="relative">
        {/* Card body */}
        <div className="relative bg-[var(--bg-panel)]/95 backdrop-blur-xl border border-[var(--border-subtle)] rounded-2xl px-4 py-3.5 shadow-xl shadow-black/20 max-w-[280px]">
          {/* Arrow */}
          <div className={ARROW_CLASSES[spotlight.position]} />

          {/* Header row: icon + close */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <Sparkles size={13} className="text-indigo-400" />
              <span className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wider">
                AI Bridge
              </span>
            </div>
            <button
              onClick={() => onDismiss(spotlight.id)}
              className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-[var(--bg-hover)] transition-colors"
              title="Close"
            >
              <X size={11} className="text-[var(--text-muted)]" />
            </button>
          </div>

          {/* Message content */}
          <p className="text-[11.5px] text-[var(--text-main)]/90 leading-[1.6] font-normal">
            {currentMessage}
          </p>

          {/* Got it button */}
          <div className="mt-3 flex justify-end">
            <button
              onClick={onDismissForever}
              className="text-[10px] font-medium text-indigo-400 hover:text-indigo-300 transition-colors px-2 py-0.5 rounded hover:bg-indigo-500/10"
            >
              Got it
            </button>
          </div>
        </div>
      </div>

      {/* Keyframes for the glow animation */}
      <style>{`
        @keyframes spotlight-glow {
          0%, 100% { background-position: 0% 50%; opacity: 0.3; }
          50% { background-position: 100% 50%; opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

// ─── EverydayTips ───────────────────────────────────────────────────────────

function EverydayTips({
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
