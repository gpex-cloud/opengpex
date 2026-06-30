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
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { asLocalShape } from '@opengpex/editor/core/types';
import type { TextLayerData } from '@opengpex/editor/core/types/models';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import { SIGNAL_FORCE_SHOW_TYPES } from '../../overlays/LayerOverlay/protocols';
import { TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, TEXT_OVERLAY_SIGNAL_SESSION_TYPE, _CMD_MODIFY_COMMIT_UID } from './protocols';
import type { TextEditingSession } from './protocols';
import { TEXT_PREEDIT_CURSOR } from '@opengpex/editor/icons';

// ─── useTextOverlayState ───────────────────────────────────────────────────────

/**
 * useTextOverlayState: TextOverlay main component state Hook
 *
 * Reads activeCraft and editingLayerId signals, handling layer validity check and Escape exit logic.
 * Returns core judgment data required for rendering.
 */
export function useTextOverlayState() {
  const { state, activeFrame } = useEditorState();
  const { actions } = useEditorServices();

  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft];
  const editingLayerId = state.interaction.signals[TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID] as string | null;

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
  };
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
 * The `disposed` guard on the session prevents blur/cancel race conditions.
 */
export function useInlineTextEditing(
  layerId: string,
  editorRef: React.RefObject<HTMLDivElement | null>,
  notifyBoundingChange: (w: number, h: number) => void,
) {
  const { activeFrame, state } = useEditorState();
  const { actions, pixels } = useEditorServices();

  const layer = activeFrame?.layers.byId[layerId];
  const textData = layer?.textData;

  // ─── Session Management ───────────────────────────────────────────────
  const sessionRef = useRef<TextEditingSession | null>(null);
  const sessionType = state.interaction.signals[TEXT_OVERLAY_SIGNAL_SESSION_TYPE] as 'create' | 'modify' | null;

  // Session initialization + clear assetId (merged into single mount effect)
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
      session.originalSnapshot = {
        assetId: layer.assetId || '',
        src: layer.src || '',
        textData: { ...layer.textData! },
        bounding: { ...layer.bounding },
        visibleShape: layer.visibleShape!,
        cx: layer.cx,
        cy: layer.cy,
      };
    }

    sessionRef.current = session;

    // Clear assetId to show raw text instead of rasterized image
    if (layer.assetId) {
      actions.updateLayer(activeFrame.id, layerId, { assetId: '', src: '' });
    }
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
          if (mode === 'auto') {
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

  // ─── handleInput (unchanged) ──────────────────────────────────────────
  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el || !activeFrame) return;
    const content = el.innerText || '';
    const mode = textData?.boxMode || 'auto';

    if (mode === 'auto') {
      const camera = activeFrame.camera;
      const rect = el.getBoundingClientRect();
      const actualW = Math.ceil(rect.width / camera.k) || 4;
      const actualH = Math.ceil(rect.height / camera.k) || 20;
      notifyBoundingChange(actualW, actualH);
    }

    actions.updateLayer(activeFrame.id, layerId, {
      textData: { ...textData!, content },
    });
  }, [actions, activeFrame, layerId, textData, notifyBoundingChange, editorRef]);

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
      // ModifySession: restore snapshot silently, zero undo impact
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

    if (mode === 'auto') {
      const el = editorRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const k = activeFrame.camera.k || 1;
        const w = Math.max(Math.ceil(rect.width / k), 4);
        const h = Math.max(Math.ceil(rect.height / k), 20);
        finalBounding = { w, h };
        finalVisibleShape = asLocalShape({ x: 0, y: 0, w, h });
      }
    }

    // Build final state
    const finalState = {
      cx: layer.cx,
      cy: layer.cy,
      bounding: finalBounding,
      visibleShape: finalVisibleShape,
      textData: { ...textData!, content },
    };

    // ModifySession: check dirty and handle checkpoint via undoable command
    if (session.type === 'modify' && session.originalSnapshot) {
      const dirty = isSessionDirty(finalState, session.originalSnapshot);
      if (!dirty) {
        // No changes: restore assetId silently, exit with zero undo impact
        actions.updateLayer(session.frameId, session.layerId, {
          assetId: session.originalSnapshot.assetId,
          src: session.originalSnapshot.src,
        });
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

    // Build updated layer copy for rasterization
    const updatedLayer = { ...layer, ...finalState };

    try {
      const asset = await pixels.rasterize.layer(updatedLayer);
      actions.updateLayer(activeFrame.id, layerId, { assetId: asset.id, src: asset.url });
    } catch (err) {
      console.warn('[TextOverlay] Rasterize failed:', err);
    }

    actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
    actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
    sessionRef.current = null;
  }, [actions, activeFrame, layer, layerId, textData, pixels, editorRef]);

  return {
    layer,
    textData,
    handleInput,
    commitEditing,
    cancelEditing,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Comprehensive dirty check: covers content, style, position, and bounding */
function isSessionDirty(
  current: { cx: number; cy: number; bounding: { w: number; h: number }; textData: TextLayerData },
  original: NonNullable<TextEditingSession['originalSnapshot']>,
): boolean {
  // Position change
  if (current.cx !== original.cx || current.cy !== original.cy) return true;
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
    c.color !== o.color ||
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
