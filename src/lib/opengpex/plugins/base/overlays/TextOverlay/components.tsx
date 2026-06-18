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

import React, { useRef, useCallback } from "react";
import { useEditorState } from "@opengpex/editor/core/context";
import { TEXT_LAYER_PADDING } from "@opengpex/editor/core/helpers/config";
import { useTextEditorFastSync, useTextBoundingFastSync } from "./useFastSync";
import { useTextOverlayState, useInlineTextEditing } from "./hooks";
import { CRAFT_DRAWER_SIGNAL_ACTIVE_CRAFT } from "../../drawers/CraftDrawer/protocols";

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
 * renders dashed borders to let users visually see the position and boundaries of text blocks.
 */
const TextBoundingOverlay = React.memo(function TextBoundingOverlay() {
  const { activeFrame, state } = useEditorState();
  const containerRef = useRef<HTMLDivElement>(null);

  // Use FastSync Ticker to follow camera changes
  useTextBoundingFastSync(containerRef, true);

  // Only show borders in text craft mode (pre-editing state)
  const isTextCraftMode =
    state.interaction.interactionMode === "craft" &&
    state.interaction.signals[CRAFT_DRAWER_SIGNAL_ACTIVE_CRAFT] === "text";

  if (!activeFrame || !isTextCraftMode) return null;

  const textLayers = activeFrame.layers.order
    .map((id) => activeFrame.layers.byId[id])
    .filter((l) => l.type === "text" && l.visible && !l.parentId);

  if (textLayers.length === 0) return null;

  const camera = activeFrame.camera;
  const canvas = activeFrame.canvas;

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none">
      {textLayers.map((layer) => {
        const localX = canvas.w / 2 + layer.cx - layer.bounding.w / 2;
        const localY = canvas.h / 2 + layer.cy - layer.bounding.h / 2;
        const screenX = localX * camera.k + camera.x;
        const screenY = localY * camera.k + camera.y;

        return (
          <div
            key={layer.id}
            className="absolute pointer-events-none"
            data-text-layer-id={layer.id}
            style={{
              left: `${screenX}px`,
              top: `${screenY}px`,
              width: `${layer.bounding.w * camera.k}px`,
              height: `${layer.bounding.h * camera.k}px`,
              border: "1px solid rgba(180, 180, 180, 0.5)",
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
  const { activeFrame } = useEditorState();
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
      } else if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        commitEditing();
      }
    },
    [cancelEditing, commitEditing],
  );

  // Auto commit on blur
  const handleBlur = useCallback(() => {
    setTimeout(() => {
      commitEditing();
    }, 0);
  }, [commitEditing]);

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
        maxWidth: `${Math.max(200, (canvas.w - localX) * camera.k)}px`,
      }}
    >
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
          // Editing state border (always displayed - light gray solid line)
          border: "1px solid rgba(180, 180, 180, 0.6)",
          borderRadius: "2px",
          padding: `${TEXT_LAYER_PADDING.y}px ${TEXT_LAYER_PADDING.x}px`,
          cursor: "text",
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

      {/* Resize Handles (hidden by default, displayed when container hovered) */}
      <TextResizeHandles />
    </div>
  );
});

// ─── TextResizeHandles ─────────────────────────────────────────────────────────

/**
 * TextResizeHandles: 8-direction resize handles
 * - defaults to opacity-0, opacity-100 when parent container hovered
 * - corner handles are L-shaped markers (borrowed from ClipOverlay)
 * - edge handles are short rectangular bars
 * - handle elements have pointer-events-auto + preventDefault to prevent loss of focus
 * - interaction area keeps pointer-events-none to avoid intercepting contenteditable clicks
 */
function TextResizeHandles() {
  // Prevent default mousedown behavior on handle to avoid contenteditable loss of focus
  const preventBlur = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  return (
    <div className="absolute -inset-3 pointer-events-none">
      {/* Corner handles - each handle has individual pointer-events-auto */}
      {(
        [
          { h: "nw", cursor: "nwse-resize", left: "0", top: "0" },
          { h: "ne", cursor: "nesw-resize", right: "0", top: "0" },
          { h: "sw", cursor: "nesw-resize", left: "0", bottom: "0" },
          { h: "se", cursor: "nwse-resize", right: "0", bottom: "0" },
        ] as const
      ).map(({ h, cursor, ...pos }) => (
        <div
          key={h}
          data-handle={h}
          onMouseDown={preventBlur}
          className="absolute w-4 h-4 opacity-0 hover:opacity-100 transition-opacity duration-200 pointer-events-auto"
          style={{ cursor, ...pos }}
        >
          <div
            className={`absolute w-full h-[2px] bg-white/80 ${h.includes("n") ? "top-0" : "bottom-0"}`}
          />
          <div
            className={`absolute h-full w-[2px] bg-white/80 ${h.includes("w") ? "left-0" : "right-0"}`}
          />
        </div>
      ))}

      {/* Edge handles */}
      <div
        data-handle="n"
        onMouseDown={preventBlur}
        className="absolute top-0 left-1/2 -translate-x-1/2 w-6 h-1.5 bg-white/70 rounded-full opacity-0 hover:opacity-100 transition-opacity duration-200 cursor-ns-resize pointer-events-auto"
      />
      <div
        data-handle="s"
        onMouseDown={preventBlur}
        className="absolute bottom-0 left-1/2 -translate-x-1/2 w-6 h-1.5 bg-white/70 rounded-full opacity-0 hover:opacity-100 transition-opacity duration-200 cursor-ns-resize pointer-events-auto"
      />
      <div
        data-handle="w"
        onMouseDown={preventBlur}
        className="absolute left-0 top-1/2 -translate-y-1/2 w-1.5 h-6 bg-white/70 rounded-full opacity-0 hover:opacity-100 transition-opacity duration-200 cursor-ew-resize pointer-events-auto"
      />
      <div
        data-handle="e"
        onMouseDown={preventBlur}
        className="absolute right-0 top-1/2 -translate-y-1/2 w-1.5 h-6 bg-white/70 rounded-full opacity-0 hover:opacity-100 transition-opacity duration-200 cursor-ew-resize pointer-events-auto"
      />
    </div>
  );
}
