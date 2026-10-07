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

'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useEditorState, useEditorServices, useVolatileInteraction } from '@opengpex/editor/core/context';
import { asLocalShape } from '@opengpex/editor/core/types';
import type { TextLayerData } from '@opengpex/editor/core/types/models';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import { SIGNAL_FORCE_SHOW_TYPES } from '../../overlays/LayerOverlay/protocols';
import {
  TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID,
  TEXT_OVERLAY_SIGNAL_SESSION_TYPE,
  TEXT_OVERLAY_SIGNAL_PLACE_MARQUEE,
  TEXT_OVERLAY_EVT_COMMIT_REQUEST,
  _CMD_MODIFY_COMMIT_UID,
} from './protocols';
import type { TextEditingSession } from './protocols';
import { isPointInLayerBorderBand } from './interactions';
import { compensateCenterX, compensateCenterY } from './anchor';
import { isAutoWidthMode } from '@opengpex/editor/core/types/models';
import { TEXT_PREEDIT_CURSOR } from '@opengpex/editor/icons';
import { useTextEditorFastSync } from './useFastSync';
import {
  computeTextLayout,
  type TextMeasureContext,
} from '@opengpex/editor/core/engine/text/textLayout';

// ─── useTextOverlayState ───────────────────────────────────────────────────────

/**
 * useTextOverlayState: TextOverlay main component state Hook
 *
 * Reads activeCraft and editingLayerId signals, handling layer validity check and Escape exit logic.
 * Returns core judgment data required for rendering.
 */
export function useTextOverlayState() {
  const { state, activeFrame } = useEditorState();
  const { actions, geometry } = useEditorServices();

  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft];
  const editingLayerId = state.interaction.signals[TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID] as string | null;
  const placeMarquee = state.interaction.signals[TEXT_OVERLAY_SIGNAL_PLACE_MARQUEE] as
    | { x: number; y: number; w: number; h: number }
    | null;

  // Detect if the layer pointed by signal is still valid
  const layerExists = !!(editingLayerId && activeFrame?.layers.byId[editingLayerId]?.type === 'text');

  useEffect(() => {
    if (editingLayerId && !layerExists) {
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
    }
  }, [editingLayerId, layerExists, actions]);

  // Force-show text layers in LayerOverlay when in text craft mode (pre-edit state)
  useEffect(() => {
    const isTextCraftPreEdit = activeCraft === 'text' && !editingLayerId;
    if (isTextCraftPreEdit) {
      actions.setStateSignal(SIGNAL_FORCE_SHOW_TYPES, ['text']);
    } else {
      // Clear the signal when leaving text craft mode or entering editing state
      actions.setStateSignal(SIGNAL_FORCE_SHOW_TYPES, null);
    }
  }, [activeCraft, editingLayerId, actions]);

  // Escape in pre-edit state -> exits craft mode (via CraftDrawer's deactivate command, following cross-plugin boundaries)
  useEffect(() => {
    if (activeCraft !== 'text' || editingLayerId) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Deactivate tool via CraftDrawer's command system (following signal ownership boundaries)
        actions.executeCommand(CraftDrawerAPI.commands.deactivate.uid);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [activeCraft, editingLayerId, actions]);

  // Pre-edit border hover: grab cursor when the pointer is on the border band
  // of a text layer (a plain drag there moves it — TextMoveHandler's pre-edit
  // border path). Hover has no InteractionEvent, so replicate the dispatcher's
  // coordinate math: viewport rect -> screen -> world -> canvas, latest
  // fast-track camera. Cmd/Ctrl hover and drags own the cursor elsewhere.
  const borderHoverRef = useRef(false);
  useEffect(() => {
    if (activeCraft !== 'text' || editingLayerId || !activeFrame) return;
    const frame = activeFrame;

    const restoreCursor = () => {
      if (borderHoverRef.current) {
        borderHoverRef.current = false;
        actions.fast.setCursor(TEXT_PREEDIT_CURSOR);
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey) return; // Cmd/Ctrl hover sets grab in the effect below
      if (actions.fast.getCursor() === 'grabbing') return;

      const container = document.querySelector('.editor-viewport-container');
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const cam = actions.fast.latestCamera(frame.id) || frame.camera;
      const world = geometry.space.screenToWorld(e.clientX - containerRect.left, e.clientY - containerRect.top, frame, cam);
      const canvasPoint = geometry.space.worldToLocal(world.x, world.y, frame);

      const order = frame.layers.order;
      let onBorder = false;
      for (let i = order.length - 1; i >= 0; i--) {
        const layer = frame.layers.byId[order[i]];
        if (!layer || layer.type !== 'text' || !layer.visible) continue;
        if (isPointInLayerBorderBand(layer, frame, canvasPoint)) {
          onBorder = true;
          break;
        }
      }

      if (onBorder) {
        borderHoverRef.current = true;
        if (actions.fast.getCursor() !== 'grab') actions.fast.setCursor('grab');
      } else {
        restoreCursor();
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      restoreCursor();
    };
  }, [activeCraft, editingLayerId, activeFrame, actions, geometry]);

  // Dynamic cursor and keyboard modifier key control (Cmd/Ctrl → grab in both pre-edit and editing states)
  useEffect(() => {
    const isTextCraft = activeCraft === 'text';
    const isPreEdit = isTextCraft && !editingLayerId;

    if (!isTextCraft) {
      // Not in text craft mode at all, clean up any lingering cursors
      if (
        actions.fast.getCursor() === TEXT_PREEDIT_CURSOR ||
        actions.fast.getCursor() === 'grab'
      ) {
        actions.fast.setCursor(null);
      }
      return;
    }

    // Default cursor for pre-edit state
    if (isPreEdit) {
      if (
        actions.fast.getCursor() !== 'grab' &&
        actions.fast.getCursor() !== 'grabbing' &&
        actions.fast.getCursor() !== TEXT_PREEDIT_CURSOR
      ) {
        actions.fast.setCursor(TEXT_PREEDIT_CURSOR);
      }
    }

    // The "rest" cursor when Cmd is released (pre-edit → preedit cursor; editing → null)
    const restCursor = isPreEdit ? TEXT_PREEDIT_CURSOR : null;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (
          actions.fast.getCursor() !== 'grab' &&
          actions.fast.getCursor() !== 'grabbing'
        ) {
          actions.fast.setCursor('grab');
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) {
        if (actions.fast.getCursor() === 'grab') {
          actions.fast.setCursor(restCursor);
        }
      }
    };

    const handleWindowBlur = () => {
      if (actions.fast.getCursor() === 'grab') {
        actions.fast.setCursor(restCursor);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [activeCraft, editingLayerId, actions]);

  useEffect(() => {
    return () => {
      // Restore cursor when component unmounts
      actions.fast.setCursor(null);
    };
  }, [actions]);

  return {
    activeFrame,
    editingLayerId,
    layerExists,
    placeMarquee,
  };
}

// ─── usePlaceMarquee ───────────────────────────────────────────────────────────

/**
 * usePlaceMarquee: Calculates screen-space projection for the drag-to-create preview marquee.
 */
export function usePlaceMarquee(rect: { x: number; y: number; w: number; h: number }) {
  const { activeFrame } = useEditorState();
  const { geometry } = useEditorServices();
  if (!activeFrame) return null;

  const canvas = activeFrame.canvas;
  const viewMatrix = geometry.camera.getCameraMatrix(activeFrame, activeFrame.camera);
  const topLeft = viewMatrix.apply({ x: canvas.w / 2 + rect.x, y: canvas.h / 2 + rect.y });
  const scale = viewMatrix.a || 1;

  return {
    left: topLeft.x,
    top: topLeft.y,
    width: Math.max(rect.w * scale, 1),
    height: Math.max(rect.h * scale, 1),
  };
}

/**
 * Shared offscreen measuring surface for the editor's layout calls (same
 * structurally-satisfied Canvas2D context the vector-source mapper uses).
 */
let editorMeasureContext: TextMeasureContext | null = null;
function getEditorMeasureContext(): TextMeasureContext | null {
  if (editorMeasureContext) return editorMeasureContext;
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  editorMeasureContext = ctx as unknown as TextMeasureContext;
  return editorMeasureContext;
}

// ─── useInlineTextEditing ──────────────────────────────────────────────────────

/**
 * useInlineTextEditing: InlineTextEditor editing logic Hook (Session-driven)
 *
 * Uses TextEditingSession pattern to manage editing lifecycle:
 * - CreateSession (new layer): cancel = undo (removes layer), commit = rasterize
 * - ModifySession (existing layer): cancel = restore snapshot (zero undo impact),
 *   commit = checkpoint only when actual changes detected
 *
 * Encapsulates keyboard handling, tool-switch commit listener, canvas commit events,
 * and layout/screenMatrix transformations so presentation components remain pure.
 */
export function useInlineTextEditing(
  layerId: string,
  externalEditorRef?: React.RefObject<HTMLDivElement | null>,
  externalNotifyBoundingChange?: (w: number, h: number) => void,
) {
  const { activeFrame, state } = useEditorState();
  const { actions, geometry } = useEditorServices();
  const cursorOverride = useVolatileInteraction('cursorOverride');

  const layer = activeFrame?.layers.byId[layerId];
  const textData = layer?.textData;

  const internalContainerRef = useRef<HTMLDivElement>(null);
  const internalEditorRef = useRef<HTMLDivElement>(null);
  const containerRef = internalContainerRef;
  const editorRef = externalEditorRef ?? internalEditorRef;

  // Fast Track integration: make editing area follow camera changes
  const { notifyBoundingChange: internalNotifyBoundingChange } = useTextEditorFastSync(
    containerRef,
    layerId,
    true, // Always sync while editor is active
  );
  const notifyBoundingChange = externalNotifyBoundingChange ?? internalNotifyBoundingChange;

  // ─── Session Management ───────────────────────────────────────────────
  const sessionRef = useRef<TextEditingSession | null>(null);
  const sessionType = state.interaction.signals[TEXT_OVERLAY_SIGNAL_SESSION_TYPE] as 'create' | 'modify' | null;

  // Session initialization (merged into single mount effect)
  useEffect(() => {
    if (!activeFrame || !layer || sessionRef.current) return;

    const session: TextEditingSession = {
      type: sessionType || 'modify',
      layerId,
      frameId: activeFrame.id,
      originalSnapshot: null,
      disposed: false,
    };

    if (session.type === 'modify') {
      // Content + layout only — geometry (cx/cy/rotation) is intentionally
      // excluded: Cmd/Ctrl+Drag during editing commits through its own
      // independent undoable transaction and must survive cancel.
      session.originalSnapshot = {
        textData: { ...layer.textData! },
        bounding: { ...layer.bounding },
        visibleShape: layer.visibleShape!,
      };
    }

    sessionRef.current = session;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize content + auto focus
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;

    if (textData?.content && !el.innerText) {
      el.innerText = textData.content;
    }

    const raf = requestAnimationFrame(() => {
      setTimeout(() => {
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          sel.selectAllChildren(el);
          sel.collapseToEnd();
        }
        if (activeFrame) {
          const mode = textData?.boxMode || 'auto';
          if (isAutoWidthMode(mode)) {
            const rect = el.getBoundingClientRect();
            const k = activeFrame.camera.k || 1;
            const w = Math.max(Math.ceil(rect.width / k), 20);
            const h = Math.max(Math.ceil(rect.height / k), 20);
            notifyBoundingChange(w, h);
          }
        }
      }, 0);
    });
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── handleInput ──────────────────────────────────────────────────────
  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el || !activeFrame) return;
    const content = el.innerText || '';
    const mode = textData?.boxMode || 'auto';

    // Content-hugging modes re-measure the box from the DOM on every input.
    // auto_width measures both axes; auto_height keeps the locked width and
    // re-measures only the height (the CSS width never changes).
    if (isAutoWidthMode(mode) || mode === 'auto_height') {
      const camera = activeFrame.camera;
      const rect = el.getBoundingClientRect();
      const actualW = isAutoWidthMode(mode)
        ? Math.ceil(rect.width / camera.k) || 4
        : layer!.bounding.w;
      const actualH = Math.ceil(rect.height / camera.k) || 20;
      notifyBoundingChange(actualW, actualH);
    }

    actions.updateLayer(activeFrame.id, layerId, {
      textData: { ...textData!, content },
    });
    // editorRef is a stable ref — the React Compiler tracks its `.current`
    // read itself and forbids the ref in the manual deps (the legacy
    // exhaustive-deps rule disagrees; it is suppressed here).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, activeFrame, layerId, textData, layer, notifyBoundingChange]);

  // ─── cancelEditing (session-aware) ────────────────────────────────────
  const cancelEditing = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.disposed) return;
    session.disposed = true;

    if (session.type === 'create') {
      // CreateSession: clear signals FIRST to prevent one-frame state tearing,
      // then undo removes the newly created layer. React batches both in same render.
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
      actions.history.undo();
    } else {
      // ModifySession: restore the CONTENT snapshot silently (zero undo
      // impact). Geometry (cx/cy/rotation) is never touched — deliberate
      // Cmd/Ctrl+Drag moves during editing commit through their own undoable
      // transactions and intentionally survive Esc.
      if (session.originalSnapshot) {
        actions.updateLayer(session.frameId, session.layerId, session.originalSnapshot);
      }
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
    }
    sessionRef.current = null;
  }, [actions]);

  // ─── commitEditing (session-aware) ────────────────────────────────────
  const commitEditing = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || session.disposed) return;
    session.disposed = true;

    if (!activeFrame || !layer) {
      sessionRef.current = null;
      return;
    }

    const content = editorRef.current?.innerText?.trim() || '';

    // ── Empty content: equivalent to cancel ──
    if (!content) {
      if (session.type === 'create') {
        // Clear signals FIRST to prevent state tearing, then undo
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
        actions.history.undo();
      } else if (session.originalSnapshot) {
        actions.updateLayer(session.frameId, session.layerId, session.originalSnapshot);
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
      }
      sessionRef.current = null;
      return;
    }

    // ── Has content: measure final bounding ──
    const mode = textData?.boxMode || 'auto';
    let finalBounding = layer.bounding;
    let finalVisibleShape = layer.visibleShape!;
    let finalCx = layer.cx;
    let finalCy = layer.cy;

    if (isAutoWidthMode(mode) || mode === 'auto_height') {
      const el = editorRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const k = activeFrame.camera.k || 1;
        const w = isAutoWidthMode(mode)
          ? Math.max(Math.ceil(rect.width / k), 4)
          : layer.bounding.w;
        const h = Math.max(Math.ceil(rect.height / k), 20);
        finalBounding = { w, h };
        finalVisibleShape = asLocalShape({ x: 0, y: 0, w, h });
        // Align-aware anchor compensation, mirroring the live
        // notifyBoundingChange path: the width change anchors per textAlign
        // (left edge / centre / right edge), height growth anchors the top.
        // This compensates for style changes (fontSize…) that happened without
        // a subsequent input event, so committing never makes the box visibly
        // jump. Same axis-aligned approximation for rotated poses.
        finalCx = compensateCenterX(layer.cx, layer.bounding.w, w, textData?.align);
        finalCy = compensateCenterY(layer.cy, layer.bounding.h, h);
      }
    }

    // Build final state
    const finalState = {
      cx: finalCx,
      cy: finalCy,
      bounding: finalBounding,
      visibleShape: finalVisibleShape,
      textData: { ...textData!, content },
    };

    // ModifySession: check dirty and handle checkpoint via undoable command
    if (session.type === 'modify' && session.originalSnapshot) {
      const dirty = isSessionDirty(finalState, session.originalSnapshot);
      if (!dirty) {
        // No changes: exit with zero undo impact
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
        sessionRef.current = null;
        return;
      }

      // Has changes: restore snapshot → execute undoable command (creates checkpoint + applies patch)
      actions.updateLayer(session.frameId, session.layerId, session.originalSnapshot);
      actions.executeCommand(_CMD_MODIFY_COMMIT_UID, {
        frameId: session.frameId,
        layerId: session.layerId,
        patch: finalState,
      });
    } else {
      // CreateSession: just apply final state (checkpoint already exists from cmd.place)
      actions.updateLayer(activeFrame.id, layerId, finalState);
    }

    actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
    actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
    sessionRef.current = null;
    // editorRef is a stable ref — see the note on handleInput above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, activeFrame, layer, layerId, textData]);

  // Keyboard handling
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // IME composition guard (first line, no exceptions): while an IME is
      // composing (isComposing, or keyCode 229 as some browsers report),
      // Enter/Escape belong to the candidate window — never newline, commit
      // or cancel; let the native behaviour through untouched.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;

      if (e.key === 'Escape') {
        // stopPropagation keeps Esc from being stolen by HotkeyManager /
        // dispatcher.cancelAll before the editor can cancel its own session.
        e.preventDefault();
        e.stopPropagation();
        cancelEditing();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        // Select-all inside the editor: let the browser's native contenteditable
        // select-all run (no preventDefault), but stop the event before it
        // reaches HotkeyManager (window-level) — its global ⌘A clip-select
        // shortcut only defers to native behaviour when a selection already
        // exists, so it swallows ⌘A while the caret sits in fresh empty text.
        e.stopPropagation();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        // Cmd/Ctrl + Enter → explicit commit and exit editing.
        e.preventDefault();
        e.stopPropagation();
        commitEditing();
      } else if (e.key === 'Enter') {
        // Plain Enter (Shift+Enter included) → newline. insertLineBreak keeps
        // the DOM on uniform <br> breaks (no <div> block mixing), so the
        // content round-trips through innerText as '\n'-separated lines —
        // exactly the split the GPU text layout uses to lay out paragraphs.
        e.preventDefault();
        document.execCommand('insertLineBreak');
      }
    },
    [cancelEditing, commitEditing],
  );

  // Commit requests from the interaction state machine (two-stage click
  // arbitration): the TextPlaceHandler consumes a canvas click during editing
  // by dispatching this event instead of creating a new layer.
  useEffect(() => {
    const requestCommit = () => commitEditing();
    window.addEventListener(TEXT_OVERLAY_EVT_COMMIT_REQUEST, requestCommit);
    return () => window.removeEventListener(TEXT_OVERLAY_EVT_COMMIT_REQUEST, requestCommit);
  }, [commitEditing]);

  // Switching away from the text tool (toolbar click or hotkey) commits the
  // session — the blur fallback was removed with the two-stage arbitration, so
  // this is the explicit replacement for that trigger.
  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft];
  const prevCraftRef = useRef(activeCraft);
  useEffect(() => {
    if (prevCraftRef.current === 'text' && activeCraft !== 'text') {
      commitEditing();
    }
    prevCraftRef.current = activeCraft;
  }, [activeCraft, commitEditing]);

  // A Cmd/Ctrl mousedown anywhere in the box will start a move drag and must
  // preventDefault: otherwise the contenteditable starts its native selection
  // drag and fast pointer movement over the text selects it mid-drag. Without
  // a modifier, every mousedown stays with the contenteditable (caret /
  // selection).
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey) e.preventDefault();
  }, []);

  const boxMode = textData?.boxMode || 'auto';
  // Fixed mode: vertical position of the content block inside the box comes
  // from the SHARED layout (computeTextLayout) as vAlignOffset — the same
  // offset the GPU renderer bakes into its baselines. Flex centering is NOT
  // used: the contenteditable keeps an invisible trailing line box (the
  // persistent <br>), which flex would center too and push the visible text
  // half a line high. Applied as paddingTop so the contenteditable itself
  // stays a plain block — caret/selection behaviour is untouched.
  let fixedVAlignOffset = 0;
  if (boxMode === 'fixed' && layer && textData) {
    const mc = getEditorMeasureContext();
    if (mc) {
      fixedVAlignOffset = computeTextLayout(
        mc,
        textData,
        textData.boxWidth || layer.bounding.w,
        textData.boxHeight || layer.bounding.h,
      ).vAlignOffset;
    }
  }

  // Calculate initial transform (for SSR/first frame, taken over by useFastSync Ticker subsequently).
  // Mirrors useFastSync: project the layer's full world matrix (incl. rotation/flip)
  // through the camera matrix, so the box is correctly rotated on the very first paint.
  let screenMatrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  let autoMaxWidth = 200;
  if (activeFrame && layer) {
    const canvas = activeFrame.canvas;
    const localX = canvas.w / 2 + layer.cx - layer.bounding.w / 2;
    const worldMatrix = geometry.transform.getLayerWorldMatrix(layer);
    const viewMatrix = geometry.camera.getCameraMatrix(activeFrame, activeFrame.camera);
    const matrix = viewMatrix.multiply(worldMatrix);
    screenMatrix = {
      a: matrix.a,
      b: matrix.b,
      c: matrix.c,
      d: matrix.d,
      tx: matrix.tx,
      ty: matrix.ty,
    };
    autoMaxWidth = Math.max(200, canvas.w - localX);
  }

  return {
    containerRef,
    editorRef,
    layer,
    textData,
    boxMode,
    fixedVAlignOffset,
    screenMatrix,
    autoMaxWidth,
    cursorOverride,
    handleInput,
    handleKeyDown,
    handleMouseDown,
    commitEditing,
    cancelEditing,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Comprehensive dirty check: covers content and style (geometry lives outside the session snapshot) */
function isSessionDirty(
  current: { bounding: { w: number; h: number }; textData: TextLayerData },
  original: NonNullable<TextEditingSession['originalSnapshot']>,
): boolean {
  // Bounding change
  if (current.bounding.w !== original.bounding.w || current.bounding.h !== original.bounding.h) return true;
  // Content change
  if (current.textData.content !== original.textData.content) return true;
  // Style changes
  const c = current.textData;
  const o = original.textData;
  return (
    c.fontFamily !== o.fontFamily ||
    c.fontSize !== o.fontSize ||
    c.fontWeight !== o.fontWeight ||
    c.color.space !== o.color.space ||
    c.color.alpha !== o.color.alpha ||
    c.color.coords.r !== o.color.coords.r ||
    c.color.coords.g !== o.color.coords.g ||
    c.color.coords.b !== o.color.coords.b ||
    c.align !== o.align ||
    c.lineHeight !== o.lineHeight ||
    c.italic !== o.italic ||
    c.underline !== o.underline ||
    c.strikethrough !== o.strikethrough ||
    c.boxMode !== o.boxMode ||
    c.boxWidth !== o.boxWidth ||
    c.boxHeight !== o.boxHeight
  );
}
