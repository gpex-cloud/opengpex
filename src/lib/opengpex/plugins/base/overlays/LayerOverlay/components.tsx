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
import { Layer, Frame } from "@opengpex/editor/core/types";
import { Focus } from "lucide-react";
import {
  useEditorState,
  useOverlayRotationSync,
} from "@opengpex/editor/core/context";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import { useLayerOverlayCommands } from "./hooks";

import { useLayerOverlaySync } from "./useFastSync";

/**
 * LayerOverlayItem: A single geometric helper element for a layer on the stage.
 */
export function LayerOverlayItem({
  layer,
  index,
  isActive,
  isHoveringActive,
  isHovered,
  showAlways,
}: {
  activeFrame: Frame;
  layer: Layer;
  index: number;
  isActive: boolean;
  isHoveringActive: boolean;
  isHovered: boolean;
  showAlways: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const prevVisibleRef = useRef(false);
  const isVisible = showAlways || (isActive && isHoveringActive) || isHovered;

  // Use viewport-unified sync hook: Optimized for Screen Space (Ticker + Matrix)
  useLayerOverlaySync(ref, labelRef, layer, true);

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
        className={`absolute -inset-[1px] transition-opacity duration-200 pointer-events-none ${isVisible ? "opacity-100" : "opacity-0"}`}
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
}

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
  const { activeFrame, state } = useEditorState();
  const { hoveredLayerId, isHoveringActiveLayer: isHoveringActive = false } =
    state.interaction;
  const activeLayerId = activeFrame?.activeLayerId;
  const { isAlwaysOn: showAlways } = useLayerOverlayCommands();

  const containerRef = useRef<HTMLDivElement>(null);

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
        .filter((layer) => layer && !layer.parentId)
        .map((layer, idx) => (
          <LayerOverlayItem
            key={layer.id}
            activeFrame={activeFrame}
            layer={layer}
            index={idx + 1}
            isActive={layer.id === activeLayerId}
            isHoveringActive={isHoveringActive}
            isHovered={layer.id === hoveredLayerId}
            showAlways={!!showAlways}
          />
        ))}
    </div>
  );
}

/**
 * LayerOverlayToggle: Toolbar toggle switch contribution
 */
export function LayerOverlayToggle() {
  const { isAlwaysOn, toggleCmd } = useLayerOverlayCommands();

  return (
    <FunctionButton
      onClick={() => toggleCmd?.execute()}
      active={isAlwaysOn}
      title={`Toggle Layer Outlines (${toggleCmd?.shortcutLabel || ""})`}
      tooltipPosition="right"
    >
      <Focus size={18} />
    </FunctionButton>
  );
}
