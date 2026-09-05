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

import React, { useRef, useCallback, useEffect, useState } from "react";
import { useEditorState, useEditorServices, useVolatileInteraction } from "@opengpex/editor/core/context";
import { TEXT_LAYER_PADDING } from "@opengpex/editor/core/helpers/config";
import { useTextEditorFastSync } from "./useFastSync";
import { useTextOverlayState, useInlineTextEditing } from "./hooks";

// ─── TextOverlayMain ───────────────────────────────────────────────────────────

/**
 * TextOverlayMain: Text overlay main component
 *
 * Renders based on state:
 * - editing_text_layer_id has value -> renders InlineTextEditor
 * - Pre-edit bounding borders are now handled by LayerOverlay via SIGNAL_FORCE_SHOW_TYPES
 */
export const TextOverlayMain = React.memo(function TextOverlayMain() {
  const { activeFrame, editingLayerId, layerExists } = useTextOverlayState();

  // Editing state: render InlineTextEditor
  if (editingLayerId && layerExists && activeFrame) {
    return <InlineTextEditor layerId={editingLayerId} />;
  }

  // Pre-editing state: LayerOverlay handles text layer outlines via force-show signal
  return null;
});

// ─── InlineTextEditor ──────────────────────────────────────────────────────────

interface InlineTextEditorProps {
  layerId: string;
}

/**
 * InlineTextEditor: contenteditable inline text editor
 *
 * Position is updated in real time via Fast Track (useFastSync) to follow canvas camera changes.
 * bounding changes are written to fast track buffer in sync, making LayerOverlay gizmo respond instantly.
 */
const InlineTextEditor = React.memo(function InlineTextEditor({
  layerId,
}: InlineTextEditorProps) {
  const { activeFrame } = useEditorState();
  const { geometry } = useEditorServices();
  const cursorOverride = useVolatileInteraction('cursorOverride');
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  // Fast Track integration: make editing area follow camera changes
  const { notifyBoundingChange } = useTextEditorFastSync(
    containerRef,
    layerId,
    true, // Always sync while editor is active
  );

  // Core editing logic (commit / cancel / input)
  const { layer, textData, handleInput, commitEditing, cancelEditing } =
    useInlineTextEditing(layerId, editorRef, notifyBoundingChange);

  // Overflow detection for fixed-mode text boxes
  const [isOverflowing, setIsOverflowing] = useState(false);

  const checkOverflow = useCallback(() => {
    const el = editorRef.current;
    if (el && textData?.boxMode === 'fixed') {
      setIsOverflowing(el.scrollHeight > el.clientHeight);
    } else {
      setIsOverflowing(false);
    }
  }, [textData?.boxMode, editorRef]);

  // Re-check overflow when box dimensions or content changes
  useEffect(() => {
    checkOverflow();
  }, [textData?.boxHeight, textData?.boxWidth, textData?.fontSize, checkOverflow]);

  // Wrap handleInput to also check overflow
  const handleInputWithOverflow = useCallback(() => {
    handleInput();
    checkOverflow();
  }, [handleInput, checkOverflow]);

  // Keyboard handling
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelEditing();
      } else if (e.key === "Enter" && !e.shiftKey) {
        // Enter without Shift → commit editing
        e.preventDefault();
        commitEditing();
      }
      // Shift+Enter → default behavior (newline in contenteditable)
    },
    [cancelEditing, commitEditing],
  );

  // Track whether the blur was caused by clicking on a drawer panel control.
  // relatedTarget alone is unreliable: non-focusable elements (dropdown items, spans)
  // won't appear as relatedTarget. We use a mousedown listener as a robust fallback.
  const drawerClickRef = useRef(false);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      drawerClickRef.current = !!(target?.closest("[data-drawer-bar]"));
    };
    document.addEventListener("mousedown", handleMouseDown, true); // capture phase
    return () => document.removeEventListener("mousedown", handleMouseDown, true);
  }, []);

  // Auto commit on blur (but NOT when focus moves to drawer panel controls)
  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      // Check 1: relatedTarget (works for focusable elements like <input>, <button>)
      const related = e.relatedTarget as HTMLElement | null;
      if (related?.closest("[data-drawer-bar]")) {
        // Drawer panel interaction — schedule refocus back to editor
        setTimeout(() => editorRef.current?.focus(), 0);
        return;
      }
      // Check 2: mousedown flag (works for non-focusable elements like dropdown items)
      if (drawerClickRef.current) {
        drawerClickRef.current = false;
        // Drawer panel interaction — schedule refocus back to editor
        setTimeout(() => editorRef.current?.focus(), 0);
        return;
      }
      commitEditing();
    },
    [commitEditing, editorRef],
  );

  if (!activeFrame || !layer || !textData) return null;

  const boxMode = textData.boxMode || "auto";

  // Calculate initial transform (for SSR/first frame, taken over by useFastSync Ticker subsequently).
  // Mirrors useFastSync: project the layer's full world matrix (incl. rotation/flip)
  // through the camera matrix, so the box is correctly rotated on the very first paint.
  const camera = activeFrame.camera;
  const canvas = activeFrame.canvas;
  const localX = canvas.w / 2 + layer.cx - layer.bounding.w / 2;
  const worldMatrix = geometry.transform.getLayerWorldMatrix(layer);
  const viewMatrix = geometry.camera.getCameraMatrix(activeFrame, camera);
  const screenMatrix = viewMatrix.multiply(worldMatrix);

  return (
      <div
        ref={containerRef}
        className="absolute pointer-events-auto"
        style={{
          left: 0,
          top: 0,
          transform: `matrix(${screenMatrix.a}, ${screenMatrix.b}, ${screenMatrix.c}, ${screenMatrix.d}, ${screenMatrix.tx}, ${screenMatrix.ty})`,
          transformOrigin: "0 0",
          minWidth: "80px",
          maxWidth: boxMode === "fixed" ? undefined : `${Math.max(200, canvas.w - localX)}px`,
        }}
      >
        {/* Relative wrapper: ensures handles align to editor bounds */}
        <div className="relative">
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={handleInputWithOverflow}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className="outline-none whitespace-pre-wrap break-words caret-[var(--accent)]"
            style={{
              fontFamily: textData.fontFamily,
              fontSize: `${textData.fontSize}px`,
              fontWeight: textData.fontWeight,
              fontStyle: textData.italic ? "italic" : "normal",
              textDecoration:
                [
                  textData.underline ? "underline" : "",
                  textData.strikethrough ? "line-through" : "",
                ]
                  .filter(Boolean)
                  .join(" ") || "none",
              color: textData.color,
              textAlign: textData.align,
              lineHeight: textData.lineHeight,
              minHeight: "1em",
              // Editing state border (always displayed - thin dashed line)
              border: "0.5px dashed rgba(180, 180, 180, 0.5)",
              borderRadius: "2px",
              padding: `${TEXT_LAYER_PADDING.y}px ${TEXT_LAYER_PADDING.x}px`,
              cursor: (cursorOverride === 'grab' || cursorOverride === 'grabbing')
                ? cursorOverride
                : "text",
              // fixed mode: force width/height + text wrapping + overflow hidden
              ...(boxMode === "fixed" && {
                width: `${textData.boxWidth}px`,
                height: `${textData.boxHeight}px`,
                overflow: "hidden",
                wordWrap: "break-word" as const,
                overflowWrap: "break-word" as const,
              }),
            }}
          />

          {/* Overflow indicator: overlays SE handle position, pointer-events-none so handle stays functional */}
          {isOverflowing && (
            <div
              className="absolute flex items-center justify-center pointer-events-none"
              style={{
                bottom: `${-7 / camera.k}px`,
                right: `${-7 / camera.k}px`,
                width: `${14 / camera.k}px`,
                height: `${14 / camera.k}px`,
                borderRadius: '50%',
                backgroundColor: 'rgba(239, 68, 68, 0.9)',
                zIndex: 10,
                fontSize: `${9 / camera.k}px`,
                fontWeight: 700,
                color: '#fff',
                lineHeight: 1,
                letterSpacing: `${-0.5 / camera.k}px`,
              }}
            >
              ···
            </div>
          )}

          {/* Resize Handles (always visible during editing, counter-scaled for consistent screen size) */}
          <TextResizeHandles cameraK={camera.k} rotation={layer.rotation} flip={layer.flip} />
        </div>
      </div>
  );
});

// ─── TextResizeHandles ─────────────────────────────────────────────────────────

/**
 * Map an on-screen direction (degrees) to the nearest of the 4 resize cursors.
 *
 * Cursors are bidirectional, so the direction is folded into [0,180) and then
 * bucketed every 45°: e/w → `ew-resize`, ne/sw → `nesw-resize`,
 * n/s → `ns-resize`, nw/se → `nwse-resize`.
 *
 * TODO(Phase 6): this is copied verbatim from MarkerOverlay/components.tsx
 * (`cursorForAngle` / `resolveHandleCursor`). Both should be lifted into the
 * shared `<TransformGizmo>` extraction (see plans doc §11/§12).
 */
function cursorForAngle(angleDeg: number): string {
  const a = ((angleDeg % 180) + 180) % 180;
  const bucket = Math.round(a / 45) % 4;
  switch (bucket) {
    case 0: return 'ew-resize';
    case 1: return 'nwse-resize';   // pointing down-right (screen +y is down)
    case 2: return 'ns-resize';
    default: return 'nesw-resize';  // pointing up-right
  }
}

/**
 * Resolve a handle's cursor for the layer's current pose.
 *
 * The editor box is drawn through the layer's full world matrix (see
 * useTextEditorFastSync), so after a canvas Rotate Left/Right the box
 * self-rotates — but CSS `cursor` keywords ignore CSS `transform`. We therefore
 * rotate the handle's local outward normal by `layer.rotation` (mirroring flips
 * first, matching the renderer's R × F convention) and pick the matching cursor.
 */
function resolveHandleCursor(
  angle: number,
  rotation: number,
  flip: { h: boolean; v: boolean } | undefined
): string {
  const rad = (angle * Math.PI) / 180;
  let dx = Math.cos(rad);
  let dy = Math.sin(rad);
  if (flip?.h) dx = -dx;
  if (flip?.v) dy = -dy;
  const screenAngle = (Math.atan2(dy, dx) * 180) / Math.PI + rotation;
  return cursorForAngle(screenAngle);
}

/**
 * TextResizeHandles: 8-direction resize handles (circular dots on the border)
 * - always visible during editing
 * - all handles are standard circular dots positioned on the dashed border
 * - counter-scaled by 1/cameraK so they appear constant screen size regardless of zoom
 * - handle elements have pointer-events-auto + preventDefault to prevent loss of focus
 * - interaction area keeps pointer-events-none to avoid intercepting contenteditable clicks
 * - cursors are rotation-aware: the container self-rotates via CSS matrix, but CSS
 *   cursor keywords ignore transforms, so each handle's cursor is recomputed from
 *   its LOCAL outward-normal angle + the layer's rotation/flip.
 */
function TextResizeHandles({
  cameraK,
  rotation,
  flip,
}: {
  cameraK: number;
  rotation: number;
  flip: { h: boolean; v: boolean } | undefined;
}) {
  // Prevent default mousedown behavior on handle to avoid contenteditable loss of focus
  const preventBlur = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  // Screen-space handle size (constant regardless of zoom)
  const SCREEN_SIZE = 10; // px on screen
  // Canvas-space size: counter-scale to maintain constant screen appearance
  const canvasSize = SCREEN_SIZE / cameraK;
  const half = canvasSize / 2;

  // `angle` is each handle's outward normal in the layer's LOCAL space, screen
  // convention (0° = +x/east, growing clockwise since screen +y points down).
  const handles = [
    // Corners
    { h: "nw", angle: 225, style: { top: -half, left: -half } },
    { h: "ne", angle: 315, style: { top: -half, right: -half } },
    { h: "sw", angle: 135, style: { bottom: -half, left: -half } },
    { h: "se", angle: 45, style: { bottom: -half, right: -half } },
    // Edges
    { h: "n", angle: 270, style: { top: -half, left: "50%", marginLeft: -half } },
    { h: "s", angle: 90, style: { bottom: -half, left: "50%", marginLeft: -half } },
    { h: "w", angle: 180, style: { left: -half, top: "50%", marginTop: -half } },
    { h: "e", angle: 0, style: { right: -half, top: "50%", marginTop: -half } },
  ] as const;

  return (
    <div className="absolute inset-0 pointer-events-none">
      {handles.map(({ h, angle, style }) => (
        <div
          key={h}
          data-handle={h}
          onMouseDown={preventBlur}
          className="absolute rounded-full bg-white border border-gray-400 shadow-sm pointer-events-auto hover:scale-125 transition-transform duration-150"
          style={{
            width: `${canvasSize}px`,
            height: `${canvasSize}px`,
            cursor: resolveHandleCursor(angle, rotation, flip),
            ...style,
          }}
        />
      ))}
    </div>
  );
}
