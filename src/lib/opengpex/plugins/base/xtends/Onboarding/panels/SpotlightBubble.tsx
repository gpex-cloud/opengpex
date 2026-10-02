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

import React, { useState, useEffect, useCallback } from "react";
import { X, Sparkles } from "lucide-react";
import { DEFAULT_CONFIG, type SpotlightDef, type SpotlightPosition } from "../protocols";

// ─── DOM Utilities ───────────────────────────────────────────────────────────

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
  const arrowOffset = 16;

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

/**
 * Check if any drawer panel is currently expanded (DOM-based detection).
 * Looks for wide panel elements (> 100px) inside the drawer bar containers.
 */
function isAnyDrawerExpanded(): boolean {
  const bars = document.querySelectorAll("[data-drawer-bar]");
  for (const bar of bars) {
    const wideElements = bar.querySelectorAll('[style*="width"]');
    for (const el of wideElements) {
      const style = (el as HTMLElement).style;
      const width = parseInt(style.width, 10);
      if (width > 100) return true;
    }
  }
  return false;
}

// ─── SpotlightBubble ─────────────────────────────────────────────────────────

export function SpotlightBubble({
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

  const locateTarget = useCallback(() => {
    const rect = findTargetElement(spotlight);
    if (rect) {
      setPosStyle(computeBubblePosition(rect, spotlight.position));
    } else {
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
  //
  // ⚠️ subtree:false — intentional. Setting subtree:true would cause the observer
  // to re-fire on the bubble's own style updates (written by locateTarget/setPosStyle),
  // creating an infinite repaint loop. We only need to watch direct children of the
  // drawer bar to detect panel open/close transitions.
  // RAF debounce further prevents multiple synchronous firings from batching into
  // a single paint frame.
  useEffect(() => {
    if (!visible) return;
    let rafId: ReturnType<typeof requestAnimationFrame>;
    const check = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        setHidden(isAnyDrawerExpanded());
        locateTarget();
      });
    };
    check();
    const observer = new MutationObserver(check);
    const bars = document.querySelectorAll("[data-drawer-bar]");
    bars.forEach((bar) =>
      observer.observe(bar, {
        childList: true,
        subtree: false, // do NOT watch subtree — avoids self-triggering loop
        attributes: true,
        attributeFilter: ["style"],
      }),
    );
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [visible, locateTarget]);

  if (!visible || !posStyle || hidden) return null;

  return (
    <div
      className="fixed pointer-events-auto"
      style={posStyle}
    >
      <div className="relative">
        <div className="relative bg-[var(--bg-panel)]/95 backdrop-blur-xl border border-[var(--border-subtle)] rounded-2xl px-4 py-3.5 shadow-xl shadow-black/20 max-w-[280px]">
          {/* Header row: icon + close */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <Sparkles size={13} className="text-indigo-400" />
              <span className="text-[10px] font-semibold text-indigo-400 tracking-wider">
                Using AI to Get Started
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

      <style>{`
        @keyframes spotlight-glow {
          0%, 100% { background-position: 0% 50%; opacity: 0.3; }
          50% { background-position: 100% 50%; opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
