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
import { CRAFT_DRAWER_SIGNAL_ACTIVE_CRAFT, CRAFT_DRAWER_CMD_DEACTIVATE_CRAFT } from '../../drawers/CraftDrawer/protocols';
import { TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID } from './protocols';
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

  const activeCraft = state.interaction.signals[CRAFT_DRAWER_SIGNAL_ACTIVE_CRAFT];
  const editingLayerId = state.interaction.signals[TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID] as string | null;

  // Detect if the layer pointed by signal is still valid
  const layerExists = !!(editingLayerId && activeFrame?.layers.byId[editingLayerId]?.type === 'text');

  useEffect(() => {
    if (editingLayerId && !layerExists) {
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
    }
  }, [editingLayerId, layerExists, actions]);

  // Escape in pre-edit state -> exits craft mode (via CraftDrawer's deactivate command, following cross-plugin boundaries)
  useEffect(() => {
    if (activeCraft !== 'text' || editingLayerId) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Deactivate tool via CraftDrawer's command system (following signal ownership boundaries)
        actions.executeCommand(CRAFT_DRAWER_CMD_DEACTIVATE_CRAFT);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [activeCraft, editingLayerId, actions]);

  // Dynamic cursor and keyboard modifier key control (listens to Cmd/Ctrl switching to grab in pre-edit state)
  useEffect(() => {
    const isPreEdit = activeCraft === 'text' && !editingLayerId;
    if (!isPreEdit) {
      // When exiting pre-edit state, if current cursor is pre-edit or grab, restore it to null
      if (
        state.interaction.cursorOverride === TEXT_PREEDIT_CURSOR ||
        state.interaction.cursorOverride === 'grab'
      ) {
        actions.setInteraction({ cursorOverride: null });
      }
      return;
    }

    // Initialize/fallback set pre-edit state cursor
    if (
      state.interaction.cursorOverride !== 'grab' &&
      state.interaction.cursorOverride !== 'grabbing' &&
      state.interaction.cursorOverride !== TEXT_PREEDIT_CURSOR
    ) {
      actions.setInteraction({ cursorOverride: TEXT_PREEDIT_CURSOR });
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (
          state.interaction.cursorOverride !== 'grab' &&
          state.interaction.cursorOverride !== 'grabbing'
        ) {
          actions.setInteraction({ cursorOverride: 'grab' });
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) {
        if (state.interaction.cursorOverride === 'grab') {
          actions.setInteraction({ cursorOverride: TEXT_PREEDIT_CURSOR });
        }
      }
    };

    const handleBlur = () => {
      if (state.interaction.cursorOverride === 'grab') {
        actions.setInteraction({ cursorOverride: TEXT_PREEDIT_CURSOR });
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [activeCraft, editingLayerId, state.interaction.cursorOverride, actions]);

  useEffect(() => {
    return () => {
      // Restore cursor when component unmounts
      actions.setInteraction({ cursorOverride: null });
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
 * useInlineTextEditing: InlineTextEditor editing logic Hook
 *
 * Encapsulates inline editor's commit / cancel / input callbacks.
 * Requires editorRef to read DOM content.
 */
export function useInlineTextEditing(
  layerId: string,
  editorRef: React.RefObject<HTMLDivElement | null>,
  notifyBoundingChange: (w: number, h: number) => void,
) {
  const { activeFrame } = useEditorState();
  const { actions, pixels } = useEditorServices();

  const layer = activeFrame?.layers.byId[layerId];
  const textData = layer?.textData;

  // Snapshot: save content and assetId when entering edit
  const snapshotRef = useRef<{ content: string; assetId: string; src: string }>({
    content: textData?.content || '',
    assetId: layer?.assetId || '',
    src: layer?.src || '',
  });

  // Enter editing state: clear assetId
  useEffect(() => {
    if (!activeFrame || !layer) return;
    if (layer.assetId) {
      snapshotRef.current = { content: textData?.content || '', assetId: layer.assetId, src: layer.src };
      actions.updateLayer(activeFrame.id, layerId, { assetId: '', src: '' });
    } else {
      snapshotRef.current = { content: textData?.content || '', assetId: '', src: '' };
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
            // auto mode: measure actual dimensions from DOM
            const rect = el.getBoundingClientRect();
            const k = activeFrame.camera.k || 1;
            const w = Math.max(Math.ceil(rect.width / k), 20);
            const h = Math.max(Math.ceil(rect.height / k), 20);
            notifyBoundingChange(w, h);
          }
          // fixed mode: bounding is already boxWidth x boxHeight, no measurement needed
        }
      }, 0);
    });
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Input handling
  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el || !activeFrame) return;
    const content = el.innerText || '';
    const mode = textData?.boxMode || 'auto';

    if (mode === 'auto') {
      // auto mode: remeasure and sync bounding on each input
      const camera = activeFrame.camera;
      const rect = el.getBoundingClientRect();
      const actualW = Math.ceil(rect.width / camera.k) || 4;
      const actualH = Math.ceil(rect.height / camera.k) || 20;
      notifyBoundingChange(actualW, actualH);
    }
    // fixed mode: bounding is fixed, no measurement

    // Both modes update content
    actions.updateLayer(activeFrame.id, layerId, {
      textData: { ...textData!, content },
    });
  }, [actions, activeFrame, layerId, textData, notifyBoundingChange, editorRef]);

  // Commit edit
  const commitEditing = useCallback(async () => {
    if (!activeFrame || !layer) return;
    const content = editorRef.current?.innerText?.trim() || '';

    if (!content) {
      actions.removeLayers(activeFrame.id, [layerId]);
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
      return;
    }

    const mode = textData?.boxMode || 'auto';

    // Build latest layer copy for rasterization (avoids empty asset from stale reference)
    let updatedLayer = { ...layer };

    if (mode === 'auto') {
      // auto mode: last measurement ensures precise bounding
      const el = editorRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const k = activeFrame.camera.k || 1;
        const finalW = Math.max(Math.ceil(rect.width / k), 4);
        const finalH = Math.max(Math.ceil(rect.height / k), 20);

        updatedLayer = {
          ...layer,
          bounding: { w: finalW, h: finalH },
          visibleShape: asLocalShape({ x: 0, y: 0, w: finalW, h: finalH }),
          textData: { ...textData!, content },
        };

        actions.updateLayer(activeFrame.id, layerId, {
          bounding: { w: finalW, h: finalH },
          visibleShape: asLocalShape({ x: 0, y: 0, w: finalW, h: finalH }),
          textData: { ...textData!, content },
        });
      }
    } else {
      // fixed mode: only update content (bounding already determined by handle operation)
      updatedLayer = {
        ...layer,
        textData: { ...textData!, content },
      };

      actions.updateLayer(activeFrame.id, layerId, {
        textData: { ...textData!, content },
      });
    }

    try {
      // Use the built latest copy for rasterization to ensure content and dimensions are precise
      const asset = await pixels.rasterize.layer(updatedLayer);
      actions.updateLayer(activeFrame.id, layerId, { assetId: asset.id, src: asset.url });
    } catch (err) {
      console.warn('[TextOverlay] Rasterize failed, falling back:', err);
    }

    actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
  }, [actions, activeFrame, layer, layerId, textData, pixels, editorRef]);

  // Cancel edit
  const cancelEditing = useCallback(() => {
    if (!activeFrame) return;
    const snapshot = snapshotRef.current;

    if (!snapshot.content && !snapshot.assetId) {
      actions.removeLayers(activeFrame.id, [layerId]);
    } else {
      actions.updateLayer(activeFrame.id, layerId, {
        assetId: snapshot.assetId,
        src: snapshot.src,
        textData: { ...textData!, content: snapshot.content },
      });
    }
    actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
  }, [actions, activeFrame, layerId, textData]);

  return {
    layer,
    textData,
    handleInput,
    commitEditing,
    cancelEditing,
  };
}
