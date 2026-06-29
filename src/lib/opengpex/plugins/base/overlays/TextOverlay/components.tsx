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

import React, { useRef, useCallback, useEffect } from "react";
import { useEditorState } from "@opengpex/editor/core/context";
import { TEXT_LAYER_PADDING } from "@opengpex/editor/core/helpers/config";
import { useTextEditorFastSync, useTextBoundingFastSync } from "./useFastSync";
import { useTextOverlayState, useInlineTextEditing } from "./hooks";
import { CraftDrawerAPI } from "../../drawers/CraftDrawer/protocols";

// ─── TextOverlayMain ───────────────────────────────────────────────────────────

/**
 * TextOverlayMain: Text overlay main component
 *
 * Renders based on state:
 * - editing_text_layer_id has value -> renders InlineTextEditor
 * - activeCraft='text' and no editing layer -> renders TextBoundingOverlay (pre-edit bounding borders)
 */
export const TextOverlayMain = React.memo(function TextOverlayMain() {
  const { activeFrame, editingLayerId, layerExists } = useTextOverlayState();

  // Editing state: render InlineTextEditor
  if (editingLayerId && layerExists && activeFrame) {
    return <InlineTextEditor layerId={editingLayerId} />;
  }

  // Pre-editing state: render borders of all text layers
  return <TextBoundingOverlay />;
});

// ─── TextBoundingOverlay ───────────────────────────────────────────────────────

/**
 * TextBoundingOverlay: Pre-editing bounding borders display
 *
 * In text craft mode (but not yet editing), for all visible text layers on canvas
 * renders dashed borders to indicate text layer positions and boundaries.
 * No handles shown here — resize only available after entering editing state.
 */
const TextBoundingOverlay = React.memo(function TextBoundingOverlay() {
  const { activeFrame, state, activeLayer } = useEditorState();
  const containerRef = useRef<HTMLDivElement>(null);

  // Use FastSync Ticker to follow camera changes
  useTextBoundingFastSync(containerRef, true);

  // Only show borders in text craft mode (pre-editing state)
  const isTextCraftMode =
    state.interaction.interactionMode === "craft" &&
    state.interaction.signals[CraftDrawerAPI.signals.activeCraft] === "text";

  if (!activeFrame || !isTextCraftMode) return null;

  const textLayers = activeFrame.layers.order
    .map((id) => activeFrame.layers.byId[id])
    .filter((l) => l.type === "text" && l.visible && !l.parentId);

  if (textLayers.length === 0) return null;

  const camera = activeFrame.camera;
  const canvas = activeFrame.canvas;
  const activeLayerId = activeLayer?.id;

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none">
      {/* Breathing pulse animation for selected text layer */}
      <style>{`
        @keyframes gpex-text-breathe {
          0%, 100% { border-color: rgba(210, 210, 210, 0.9); }
          50% { border-color: rgba(180, 180, 180, 0.55); }
        }
        .gpex-text-breathe {
          animation: gpex-text-breathe 1.6s ease-in-out infinite;
        }
      `}</style>
      {textLayers.map((layer) => {
        const localX = canvas.w / 2 + layer.cx - layer.bounding.w / 2;
        const localY = canvas.h / 2 + layer.cy - layer.bounding.h / 2;
        const screenX = localX * camera.k + camera.x;
        const screenY = localY * camera.k + camera.y;
        const isActive = layer.id === activeLayerId;

        return (
          <div
            key={layer.id}
            className={`absolute${isActive ? ' gpex-text-breathe' : ''}`}
            data-text-layer-id={layer.id}
            style={{
              left: `${screenX}px`,
              top: `${screenY}px`,
              width: `${layer.bounding.w * camera.k}px`,
              height: `${layer.bounding.h * camera.k}px`,
              border: isActive
                ? "1.5px dashed rgba(210, 210, 210, 0.9)"
                : "1px dashed rgba(180, 180, 180, 0.6)",
              borderRadius: "2px",
            }}
          />
        );
      })}
    </div>
  );
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
  const { activeFrame, state } = useEditorState();
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

  // Calculate initial screen coordinates (for SSR/first frame, taken over by useFastSync Ticker subsequently)
  const camera = activeFrame.camera;
  const canvas = activeFrame.canvas;
  const localX = canvas.w / 2 + layer.cx - layer.bounding.w / 2;
  const localY = canvas.h / 2 + layer.cy - layer.bounding.h / 2;
  const screenX = localX * camera.k + camera.x;
  const screenY = localY * camera.k + camera.y;

  return (
      <div
        ref={containerRef}
        className="absolute pointer-events-auto"
        style={{
          left: `${screenX}px`,
          top: `${screenY}px`,
          transform: `scale(${camera.k})`,
          transformOrigin: "top left",
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
            onInput={handleInput}
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
              // Editing state border (always displayed - dashed line)
              border: "1px dashed rgba(180, 180, 180, 0.6)",
              borderRadius: "2px",
              padding: `${TEXT_LAYER_PADDING.y}px ${TEXT_LAYER_PADDING.x}px`,
              cursor: (state.interaction.cursorOverride === 'grab' || state.interaction.cursorOverride === 'grabbing')
                ? state.interaction.cursorOverride
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

          {/* Resize Handles (always visible during editing, counter-scaled for consistent screen size) */}
          <TextResizeHandles cameraK={camera.k} />
        </div>
      </div>
  );
});

// ─── TextResizeHandles ─────────────────────────────────────────────────────────

/**
 * TextResizeHandles: 8-direction resize handles (circular dots on the border)
 * - always visible during editing
 * - all handles are standard circular dots positioned on the dashed border
 * - counter-scaled by 1/cameraK so they appear constant screen size regardless of zoom
 * - handle elements have pointer-events-auto + preventDefault to prevent loss of focus
 * - interaction area keeps pointer-events-none to avoid intercepting contenteditable clicks
 */
function TextResizeHandles({ cameraK }: { cameraK: number }) {
  // Prevent default mousedown behavior on handle to avoid contenteditable loss of focus
  const preventBlur = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  // Screen-space handle size (constant regardless of zoom)
  const SCREEN_SIZE = 8; // px on screen
  // Canvas-space size: counter-scale to maintain constant screen appearance
  const canvasSize = SCREEN_SIZE / cameraK;
  const half = canvasSize / 2;

  const handles = [
    // Corners
    { h: "nw", cursor: "nwse-resize", style: { top: -half, left: -half } },
    { h: "ne", cursor: "nesw-resize", style: { top: -half, right: -half } },
    { h: "sw", cursor: "nesw-resize", style: { bottom: -half, left: -half } },
    { h: "se", cursor: "nwse-resize", style: { bottom: -half, right: -half } },
    // Edges
    { h: "n", cursor: "ns-resize", style: { top: -half, left: "50%", marginLeft: -half } },
    { h: "s", cursor: "ns-resize", style: { bottom: -half, left: "50%", marginLeft: -half } },
    { h: "w", cursor: "ew-resize", style: { left: -half, top: "50%", marginTop: -half } },
    { h: "e", cursor: "ew-resize", style: { right: -half, top: "50%", marginTop: -half } },
  ] as const;

  return (
    <div className="absolute inset-0 pointer-events-none">
      {handles.map(({ h, cursor, style }) => (
        <div
          key={h}
          data-handle={h}
          onMouseDown={preventBlur}
          className="absolute rounded-full bg-white border border-gray-400 shadow-sm pointer-events-auto hover:scale-125 transition-transform duration-150"
          style={{
            width: `${canvasSize}px`,
            height: `${canvasSize}px`,
            cursor,
            ...style,
          }}
        />
      ))}
    </div>
  );
}
