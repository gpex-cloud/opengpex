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

import { useRef, useEffect, useState } from "react";
import {
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import PluginSlot from "@opengpex/editor/workspace/components/PluginSlot";
import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";
import { useViewportSync } from "@opengpex/editor/core/context";
import { useViewportEvents } from "./useViewportEvents";
import { useCameraInit } from "./useCameraInit";
import CanvasBackdrop from "./CanvasBackdrop";
import CanvasStage from "../layers/canvas2d/CanvasStage";

import { Frame } from "@opengpex/editor/core/types";

interface ViewportProps {
  frameId: string;
}

/**
 * Viewport: Full-featured core physical engine wrapper
 * Checks frame existence and renders ViewportInner unconditionally to satisfy React Hook rules.
 */
export default function Viewport({ frameId }: ViewportProps) {
  const { state } = useEditorState();
  const frame = state.frames.byId[frameId];

  if (!frame) return null;

  return <ViewportInner frame={frame} />;
}

interface ViewportInnerProps {
  frame: Frame;
}

function ViewportInner({ frame }: ViewportInnerProps) {
  const { state } = useEditorState();
  const { geometry, actions } = useEditorServices();

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const artboardRef = useRef<HTMLDivElement>(null);

  // [For Debugging] Allows users to toggle checkerboard backdrop via console
  const [showChess, setShowChess] = useState(true);
  useEffect(() => {
    (window as unknown as Record<string, unknown>).setIsChess = setShowChess;
  }, []);

  // 1. Interaction Handlers
  const { handleMouseDown, handleMouseMove, handleMouseUp, handleMouseLeave } =
    useViewportEvents(containerRef, frame);

  // 2. Initial auto-centering logic (driven by LayoutContext)
  useCameraInit(containerRef, frame, state, actions);

  // 3. Unified Sync Master (unified geometric synchronization proxy)
  const { isGroomed } = useViewportSync(stageRef, artboardRef, frame);

  const cursorOverride = state.interaction.cursorOverride;
  const cursorClass = cursorOverride
    ? ""
    : state.interaction.interactionMode === "pan"
      ? "cursor-grab active:cursor-grabbing"
      : state.interaction.interactionMode === "clip"
        ? "cursor-crosshair"
        : "cursor-default";

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onContextMenu={(e) => e.preventDefault()}
      className={`editor-viewport-container relative w-full h-full overflow-hidden select-none outline-none ${cursorClass}`}
      style={{ touchAction: "none", cursor: cursorOverride || undefined }}
    >
      <CanvasBackdrop
        rotation={frame.rotation}
        canvas={frame.canvas}
        geometry={geometry}
        frame={frame}
        showChess={showChess}
      />

      <div
        ref={stageRef}
        className="absolute top-0 left-0 will-change-transform origin-top-left"
        style={!isGroomed ? { opacity: 0 } : {}}
      >
        <div
          ref={artboardRef}
          className="relative"
          style={{
            maxWidth: "none",
            maxHeight: "none",
          }}
        >
          <div className="absolute inset-0 overflow-hidden rounded-[inherit]"></div>

          <PluginSlot
            name="STAGE_GIZMOS"
            className="absolute inset-0 pointer-events-none overflow-visible"
            style={{ zIndex: EDITOR_Z_INDEX.STAGE.GIZMOS }}
          />
        </div>
      </div>

      <div
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: 5 }}
      >
        <CanvasStage />
      </div>

      <PluginSlot
        name="STAGE_OVERLAY"
        className="absolute inset-0 pointer-events-none overflow-visible"
        style={{ zIndex: EDITOR_Z_INDEX.STAGE.GIZMOS }}
      />
    </div>
  );
}
