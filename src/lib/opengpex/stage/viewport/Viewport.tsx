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
import { useViewportSync, useVolatileInteraction } from "@opengpex/editor/core/context";
import { useViewportEvents } from "./useViewportEvents";
import { useCameraInit } from "./useCameraInit";
import CanvasBackdrop from "./CanvasBackdrop";
import CanvasStage from "../layers/canvas2d/CanvasStage";

import { Frame, AssetService } from "@opengpex/editor/core/types";
import { sourceBitmapCache, getGpuEngine } from "@opengpex/editor/core/engine/renderer";
import { GpuDevice } from "@opengpex/editor/core/gpu/device/GpuDevice";

interface ViewportProps {
  frameId: string;
}

function checkAllImagesLoaded(frame: Frame, assets?: AssetService): boolean {
  const visibleImageLayers = frame.layers.order
    .map((id) => frame.layers.byId[id])
    .filter((l) => l && l.visible && l.type === 'image' && l.src);

  if (visibleImageLayers.length === 0) return true;

  return visibleImageLayers.every((l) => {
    const src = assets ? assets.resolve(l.assetId, l.src) : l.src;
    if (!src) return true;
    return !!sourceBitmapCache.getOrFetch(src);
  });
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
  const { geometry, assets, actions } = useEditorServices();

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const artboardRef = useRef<HTMLDivElement>(null);

  // [For Debugging] Allows users to toggle checkerboard backdrop via console
  const [showChess, setShowChess] = useState(true);
  useEffect(() => {
    (window as unknown as Record<string, unknown>).setIsChess = setShowChess;
  }, []);

  // 1. Interaction Handlers
  const { handlePointerDown, handlePointerMove, handlePointerUp, handlePointerLeave } =
    useViewportEvents(containerRef, frame);

  // 2. Initial auto-centering logic (driven by LayoutContext)
  useCameraInit(containerRef, frame, state, actions);

  // 3. Unified Sync Master (unified geometric synchronization proxy)
  const { isGroomed } = useViewportSync(stageRef, artboardRef, frame);

  // 4. Synchronized content readiness — two milestones must BOTH be met before
  //    the stage (checkerboard + WebGPU canvas) is revealed:
  //      (a) imagesLoaded — visible image bitmaps are decoded into the cache;
  //      (b) hasPainted   — the GPU has actually SUBMITTED a frame containing
  //                         them to the swapchain.
  //
  //    Gating on (a) alone (the previous design) was insufficient: a decoded
  //    bitmap is not the same milestone as "pixels are on screen". The SVG
  //    checkerboard is synchronous DOM, so revealing on (a) let the board fade
  //    in a tick or more before the WebGPU image caught up — the reported
  //    "checkerboard flashes, image pops in late" bug. Waiting for the real
  //    first paint (b) keeps board and image in lockstep.
  const [imagesLoaded, setImagesLoaded] = useState(() => checkAllImagesLoaded(frame, assets));

  useEffect(() => {
    const check = () => {
      const loaded = checkAllImagesLoaded(frame, assets);
      setImagesLoaded(loaded);
    };
    check();
    const unsubscribe = sourceBitmapCache.subscribe(check);
    return unsubscribe;
  }, [frame, assets]);

  useEffect(() => {
    if (imagesLoaded) return;
    const timer = setTimeout(() => {
      setImagesLoaded(true);
    }, 1500);
    return () => clearTimeout(timer);
  }, [imagesLoaded]);

  // First-paint gate. Only arm it once bitmaps are decoded, so the paint we
  // wait for is guaranteed to contain the image (not an empty clear frame).
  // Initial value: when WebGPU is unavailable (unsupported / SSR) there is no
  // paint signal to wait for, so fall back to the decode milestone up front.
  const [hasPainted, setHasPainted] = useState(() => !GpuDevice.isSupported());

  useEffect(() => {
    if (!imagesLoaded || hasPainted) return;

    const engine = getGpuEngine();
    const unsub = engine.onFirstPaint(() => setHasPainted(true));

    // Safety net: reveal anyway if no paint arrives (e.g. device init pending
    // or canvas detached) so the stage can never get stuck invisible.
    const timer = setTimeout(() => setHasPainted(true), 1500);

    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, [imagesLoaded, hasPainted]);

  const isReady = isGroomed && hasPainted;

  const cursorOverride = useVolatileInteraction('cursorOverride');
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
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onContextMenu={(e) => e.preventDefault()}
      className={`editor-viewport-container relative w-full h-full overflow-hidden select-none outline-none ${cursorClass}`}
      style={{ touchAction: "none", cursor: cursorOverride || undefined }}
    >
      <div
        className="absolute inset-0 transition-opacity duration-150"
        style={{ opacity: isReady ? 1 : 0 }}
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
          className="absolute top-0 left-0 will-change-transform origin-top-left pointer-events-none"
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
    </div>
  );
}
