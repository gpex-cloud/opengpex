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

/* eslint-disable react-hooks/refs */

"use client";

import React, { useRef, useEffect } from "react";
import { Layer } from "@opengpex/editor/core/types";
import { Focus } from "lucide-react";
import {
  useEditorState,
  useVolatileInteraction,
  useOverlayRotationSync,
} from "@opengpex/editor/core/context";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import { useLayerOverlayCommands } from "./hooks";

import { useLayerOverlaySync, useLayerOverlayCameraHide } from "./useFastSync";

/**
 * LayerOverlayItem: A single geometric helper element for a layer on the stage.
 *
 * Memoized + self-subscribed: hover state is read HERE (per item), not in the
 * container. Earlier measurement: with the container subscribing and passing
 * hover props down, every row crossing flushed a synchronous re-render of ALL
 * N items (~9.65ms per boundary event at ~N items), which backed up the input
 * queue ~100ms and delayed the row hover highlight. With the subscription
 * inverted, each volatile notify costs N cheap getSnapshot compares (O(1) per
 * item) and only the one or two items whose isHovered/activeHovered actually
 * flipped re-render; the container itself no longer re-renders on hover at
 * all, so no per-crossing cost scales with N.
 */
export const LayerOverlayItem = React.memo(function LayerOverlayItem({
  layer,
  index,
  isActive,
  showAlways,
}: {
  layer: Layer;
  index: number;
  isActive: boolean;
  showAlways: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const prevVisibleRef = useRef(false);
  // Hover state via the public volatile hook with per-item DERIVED boolean
  // snapshots (shared keys, one subscription per row per field).
  // useSyncExternalStore compares snapshot values per hook instance, so a
  // crossing wakes every subscriber's listener but only the two rows whose
  // derived boolean actually flips re-render; the rest pay one closure
  // evaluation each and nothing else. The derives below are pure functions of
  // the field value — the snapshot must never be the raw field itself (every
  // row's value would change per crossing and all N rows would re-render,
  // which is exactly the storm this pattern exists to avoid).
  const isHovered = useVolatileInteraction('hoveredLayerId', (v) => v === layer.id);
  const activeHovered = useVolatileInteraction('isHoveringActiveLayer', (v) => !!v && isActive);
  const isVisible = showAlways || (isActive && activeHovered) || isHovered;

  // Use viewport-unified sync hook: Optimized for Screen Space (Ticker + Matrix)
  // [Perf] Only register ticker when overlay is visible — eliminates N×120Hz
  // useless matrix computations when overlay is hidden. The useLayoutEffect inside
  // useFastSync guarantees correct positioning on the first visible frame.
  //
  // [Perf] The hook also handles:
  //   - Interaction hide: instantly sets opacity:0 during pan/zoom (bypasses CSS transition)
  //   - Canvas-sized hide: hides layers whose dimensions match the canvas exactly
  //   - Internal 30Hz throttle: matrix computation is self-throttled, but interaction
  //     detection runs every frame for zero-delay response.
  useLayerOverlaySync(ref, labelRef, layer, isVisible);

  useEffect(() => {
    prevVisibleRef.current = isVisible;
  }, [isVisible]);

  return (
    <div
      ref={ref}
      className={`absolute top-0 left-0 will-change-transform origin-top-left pointer-events-none ${!layer.visible ? "invisible" : ""}`}
      style={{
        zIndex: isActive ? 10 : 1,
        opacity: isVisible ? 1 : 0,
        transition: "opacity 0.2s ease-out",
        // Handle slight delay on appearance to enhance visual rhythm
        transitionDelay:
          isVisible && !prevVisibleRef.current && !showAlways ? "0.12s" : "0s",
      }}
    >
      {/* Unified Layer Outline (Standard 1px Contrast Line) */}
      <div
        className={`absolute -inset-x-[6px] -inset-y-[4px] transition-opacity duration-200 pointer-events-none ${isVisible ? "opacity-100" : "opacity-0"}`}
      >
        <svg className="absolute inset-0 w-full h-full overflow-visible">
          {/* Base Layer: Solid Black Line for contrast */}
          <rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            fill="none"
            stroke="#000000"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          {/* Top Layer: Dashed Line (White for passive, Emerald for active) */}
          <rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            fill="none"
            stroke={isActive ? "#10b981" : "#ffffff"}
            strokeWidth="1"
            strokeDasharray="2, 2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* Layer Index Label: '#n' sequence hint */}
        <div
          ref={labelRef}
          className="absolute top-0 left-0 -translate-x-1 -translate-y-full mb-1 origin-top-left will-change-transform"
        >
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-zinc-900 border border-white/10 rounded-full shadow-lg">
            <span className="text-[10px] font-bold text-white leading-none">
              #{index}
            </span>
            <span className="text-[10px] font-medium text-white/50 leading-none truncate max-w-[80px]">
              {layer.name.toUpperCase()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * LayerOverlayContainer: Main container component
 */
export function LayerOverlayContainer() {
  return (
    <>
      <style>{`
        @keyframes marching-ants {
          from { stroke-dashoffset: 0; }
          to { stroke-dashoffset: -12; }
        }
      `}</style>
      <LayerOverlayContent />
    </>
  );
}

function LayerOverlayContent() {
  const { activeFrame } = useEditorState();
  const activeLayerId = activeFrame?.activeLayerId;
  const { isAlwaysOn: showAlways } = useLayerOverlayCommands();

  const containerRef = useRef<HTMLDivElement>(null);

  // Host-owned visibility policy: fade the whole container during camera moves.
  // Per-item hooks stay policy-free (matrix sync + canvas-sized hide only).
  useLayerOverlayCameraHide(containerRef);

  // Core: Sync viewport rotation animation (counter-animation protocol)
  useOverlayRotationSync(containerRef, activeFrame);

  if (!activeFrame) return null;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none overflow-hidden rounded-[inherit]"
    >
      {activeFrame.layers.order
        .map((id) => activeFrame.layers.byId[id])
        .filter((layer) => layer && !layer.hostId)
        .map((layer, idx) => (
          <LayerOverlayItem
            key={layer.id}
            layer={layer}
            index={idx + 1}
            isActive={layer.id === activeLayerId}
            showAlways={!!showAlways}
          />
        ))}

      {/* Layer move/rotate feedback moved to the system-level
          the entity HUD's delta chip, fed by InteractionTransaction
          declarations — this overlay no longer renders its own chip. */}
    </div>
  );
}

/**
 * LayerOverlayToggle: Toolbar toggle switch contribution
 */
export function LayerOverlayToggle() {
  const { isAlwaysOn, toggleCmd } = useLayerOverlayCommands();

  return (
    <FancyButton
      onClick={() => toggleCmd?.execute()}
      active={isAlwaysOn}
      title={`Toggle Layer Outlines (${toggleCmd?.shortcutLabel || ""})`}
      tooltipPosition="right"
      iconOnly
      shape="rect"
    >
      <Focus size={18} />
    </FancyButton>
  );
}
