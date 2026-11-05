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

import { useEffect, useCallback, useRef, useState } from 'react';
import { useEditorState, useEditorServices, useVolatileInteraction } from '@opengpex/editor/core/context';
import { asLocalShape, VolatileState } from '@opengpex/editor/core/types';
import { LayerUtils } from '@opengpex/editor/core/layer/utils';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import { LayersDrawerAPI } from '../../../drawers/LayersDrawer/protocols';
import {
  TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID,
  TEXT_OVERLAY_SIGNAL_SESSION_TYPE,
  TEXT_OVERLAY_EVT_COMMIT_REQUEST,
  TEXT_SESSION_RAW_EDITS,
} from '../protocols';
import type { TextEditingSession } from '../protocols';
import { consumePendingEditCaretPoint } from '../interactions';
import { isSessionDirty } from './session';
import { textLayoutSignature } from './styling';
import { placeCaretAtPoint } from '@opengpex/editor/widgets/TextCaretKit';
import { compensateCenterX, compensateCenterY } from '../geometry';
import { normalizeBoxMode } from '@opengpex/editor/core/types/models';
import { getEditorMeasureContext, measureEditorBox } from './measuring';
import { useTextEditorFastSync } from './useFastSync';
import {
  computeTextLayout,
} from '@opengpex/editor/core/engine/text/textLayout';

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
  const globalCursor = useVolatileInteraction('globalCursor');

  const layer = activeFrame?.layers.byId[layerId];
  const textData = layer?.textData;

  const internalContainerRef = useRef<HTMLDivElement>(null);
  const internalEditorRef = useRef<HTMLDivElement>(null);
  const containerRef = internalContainerRef;
  const editorRef = externalEditorRef ?? internalEditorRef;

  // Live content mirror for render-time consumers (fixed-mode vertical
  // alignment offset, caret layout input). Typed content lives in the DOM and
  // the fast-track draft only — the slow track is frozen during the session —
  // so without this local mirror the render-time layout math would keep
  // solving against the session-start content. Local component state (NOT the
  // slow track): one re-render of this memoized editor per keystroke, no
  // Redux dispatch.
  const [liveContent, setLiveContent] = useState<string | null>(null);

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
      historyMark: actions.history.mark(activeFrame.id),
    };

    if (session.type === 'modify') {
      // Content + layout only — geometry (cx/cy/rotation) is intentionally
      // excluded: Cmd/Ctrl+Drag during editing commits through its own
      // independent undoable transaction and must survive cancel.
      //
      // This snapshot exists ONLY for the commit's dirty gate ("did the
      // session change anything?") and the empty-content restore on cancel.
      // It is NOT a drift compensation: interim writes live in the fast-track
      // draft and never dirty the slow track, so the snapshot always equals
      // the state the session-start checkpoint froze.
      session.originalSnapshot = {
        textData: { ...layer.textData! },
        bounding: { ...layer.bounding },
        visibleShape: layer.visibleShape!,
      };
    }
    // Create sessions capture nothing: the place command's checkpoint froze
    // the placed state and the session never writes the slow track, so the
    // empty-content exit needs only rewindTo + undo — the pending undo pops
    // the creation step against a clean diff with no snapshot restore.

    sessionRef.current = session;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Session unmount safety net: commit/cancel are the normal bookends, but an
  // abnormal exit (e.g. a document-history undo removed the layer mid-session,
  // or the frame switched) tears the editor down without either running. The
  // session's fast-track drafts must still be dropped, or they shadow Redux
  // geometry forever (the pre-edit frozen-box leak, through the back door).
  useEffect(() => () => {
    const session = sessionRef.current;
    if (session && !session.disposed) {
      actions.fast.discardLayerDraft(session.layerId);
      sessionRef.current = null;
    }
  }, [actions]);

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
          // If the session was started by a pointer gesture, drop the caret at
          // the clicked position (viewport-space point resolved against the
          // freshly laid-out editor DOM). Falls back to end-of-text when the
          // point is unavailable or unresolvable (e.g. non-pointer entry).
          const clickPoint = consumePendingEditCaretPoint();
          const placed = clickPoint
            ? placeCaretAtPoint(el, clickPoint.clientX, clickPoint.clientY)
            : false;
          if (!placed) {
            sel.selectAllChildren(el);
            sel.collapseToEnd();
          }
        }
        if (activeFrame) {
          const mode = normalizeBoxMode(textData?.boxMode);
          if (mode === 'auto_width') {
            const { w, h } = measureEditorBox(el, activeFrame.camera.k);
            notifyBoundingChange(w, h);
          }
        }
      }, 0);
    });
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ─── Style-driven box re-measure ──────────────────────────────────────
  // Content-hugging modes re-measure the box from the DOM after every layout
  // change. auto_width measures both axes; auto_height keeps the locked width
  // and re-measures only the height (the CSS width never changes); fixed is
  // excluded — the user owns that box, so clipping overflow is the mode's
  // semantics, not a bug.
  const remeasureEditorBox = useCallback(() => {
    const el = editorRef.current;
    if (!el || !activeFrame || !layer) return;
    const mode = normalizeBoxMode(textData?.boxMode);
    if (mode !== 'auto_width' && mode !== 'auto_height') return;
    const { w, h } = measureEditorBox(el, activeFrame.camera.k);
    const actualW = mode === 'auto_width' ? w : layer.bounding.w;
    notifyBoundingChange(actualW, h);
    // editorRef is a stable ref — the React Compiler tracks its `.current`
    // read itself and forbids the ref in the manual deps (the legacy
    // exhaustive-deps rule disagrees; it is suppressed here).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFrame, layer, textData, notifyBoundingChange]);

  // ─── handleInput ──────────────────────────────────────────────────────
  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el || !activeFrame) return;
    const content = el.innerText || '';

    remeasureEditorBox();

    // Flag the raw span so the next LEDGERED write (a panel style command)
    // flushes it into its own checkpoint step first — otherwise the style
    // command's baseline diff would swallow the typing and one undo would
    // revert text and style together. Cleared by whoever flushes, and at
    // session commit/cancel.
    TEXT_SESSION_RAW_EDITS.pending = true;

    // Typed content lands ONLY in the fast-track draft: the volatile patch
    // shallow-overlays the layer, so textData must be written as a whole
    // object — the session's slow-track textData as the style base, with the
    // fresh DOM content on top. The draft write follows the local-merge
    // pattern (spread the existing patch; never assign a fresh patch object)
    // so the geometry keys notifyBoundingChange wrote survive alongside the
    // content key. The slow track is ledgered exclusively at the session
    // bookends (commitEditing's final updateLayer) — an unledgered
    // updateLayer here left the frame dirty above the session checkpoint.
    const compositeKey = LayerUtils.getCompositeKey(activeFrame.id, layerId);
    actions.mutateVolatile((v: VolatileState) => {
      const draft = v.buffered.layers[compositeKey] ?? {};
      v.buffered.layers[compositeKey] = {
        ...draft,
        patch: {
          ...draft.patch,
          textData: { ...(draft.patch?.textData ?? textData!), content },
        },
      };
    });

    // Refresh the render-time layout consumers (fixed-mode vertical
    // alignment, caret layout input) against the content that just landed in
    // the DOM — see the liveContent note above.
    setLiveContent(content);
    // editorRef is a stable ref — the React Compiler tracks its `.current`
    // read itself and forbids the ref in the manual deps (the legacy
    // exhaustive-deps rule disagrees; it is suppressed here).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, activeFrame, layerId, textData, layer, notifyBoundingChange, remeasureEditorBox]);

  // ─── Style changes re-measure the box (layout-affecting fields only) ──
  // Style changes arriving while a session is live (the CraftDrawer panel
  // writes textData directly) re-lay-out the contenteditable and the GPU
  // renderer immediately, but nothing re-measured the box — bounding and
  // visibleShape stayed stale until commit, so GPU text clipped against its
  // own visibleShape while typing re-measured in real time. This effect
  // closes that gap: whenever a layout-affecting style field changes on the
  // live layer, push the freshly laid-out DOM size through the same fast
  // channel the input path uses. Keyed on the layout-affecting signature so
  // decorative-only changes (italic, underline, …) don't trigger it, and
  // skipped on mount — the session-mount effect owns the first measurement.
  const layoutSignature = textLayoutSignature(textData);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    remeasureEditorBox();
  }, [layoutSignature, remeasureEditorBox]);

  // ─── cancelEditing (session-aware) ────────────────────────────────────
  const cancelEditing = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.disposed) return;
    session.disposed = true;

    // Session-end fast-track bookend: the live box measurements wrote layer
    // drafts into the volatile buffer as visibility aids; drop them (never
    // land) BEFORE the undo/restore dispatches below, so the merged frame the
    // Ticker renders reflects the restored Redux state instead of a stale
    // geometry shadow. Without this the draft survives the session forever and
    // freezes every pre-edit style-driven box update until an unrelated
    // gesture happens to flush the buffer.
    actions.fast.discardLayerDraft(session.layerId);
    TEXT_SESSION_RAW_EDITS.pending = false;

    // Session-cancel history bookend: any undo steps recorded inside the
    // session (per-op panel style commands) die with the cancel — the state
    // restore below replaces the states those steps were diffed against, and
    // a linear patch chain must never be applied across that boundary.
    actions.history.rewindTo(session.frameId, session.historyMark);

    if (session.type === 'create') {
      // CreateSession: clear signals FIRST to prevent one-frame state tearing,
      // then rewind the stack and undo pops the creation step. The session
      // never wrote the slow track, so the frame diffs clean against the
      // place checkpoint and no snapshot restore is needed.
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
      actions.history.rewindTo(session.frameId, session.historyMark);
      actions.history.undo();
    } else {
      // ModifySession: restore the CONTENT snapshot silently (zero undo
      // impact — the checkpoint already sits at the session-start state the
      // snapshot restores, so no new step is recorded). Geometry (cx/cy/
      // rotation) is never touched — deliberate Cmd/Ctrl+Drag moves during
      // editing intentionally survive Esc.
      if (session.originalSnapshot) {
        actions.updateLayer(session.frameId, session.layerId, session.originalSnapshot);
      }
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
      // Checkpoint-drift bookend: per-op style commands executed INSIDE the
      // session are undoable, so each one's pre-execution SIGNAL_COMMIT
      // folds the previous one into a step and advances the checkpoint.
      // rewindTo above drops those steps but HISTORY_TRUNCATE keeps the
      // (now drifted) checkpoint — left in place, the next undoable boundary
      // would diff the drifted baseline against the restored layer and
      // record the style rollback as a phantom step. Re-basing the
      // checkpoint onto the restored state makes the cancel a true no-op
      // for the ledger.
      actions.history.commitCheckpoint(session.frameId);
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

    // The session's live truth: fast-track draft ⊕ slow track. The slow track
    // is frozen during the session (interim writes land in the draft), so the
    // geometry compensated while typing lives only in the draft, while a
    // mid-session Cmd/Ctrl+Drag (its own undoable transaction) lives in the
    // slow track. Only the merged layer contains both, so every final value
    // below baselines against it — never against the frozen Redux snapshot.
    // Read BEFORE the discard bookend below: it clears `interacting`
    // synchronously, which would make latestLayer fall back to the slow track.
    const liveLayer = actions.fast.latestLayer(session.frameId, session.layerId) ?? layer;

    // Session-end fast-track bookend: drop this session's buffered layer draft
    // (never land it) — the final state below lands to Redux through a plain
    // updateLayer + history rebase, so the draft is stale the moment this
    // runs. Left in place it would shadow Redux geometry for every
    // merged-frame consumer and freeze pre-edit style-driven box updates.
    actions.fast.discardLayerDraft(session.layerId);
    TEXT_SESSION_RAW_EDITS.pending = false;

    // Empty determination trims, but the stored content must NOT: a trailing
    // space the user typed is a real edit, and trimming it here silently
    // discarded it on every commit (most visible in fixed/auto_height boxes
    // where a trailing space at the line edge renders as nothing).
    const raw = editorRef.current?.innerText || '';
    const content = raw.trim() ? raw : '';

    // ── Empty content ──
    // Create session: undo removes the freshly placed layer entirely.
    // Modify session: the user deleted every character and committed — the
    // layer is dead (Figma/Sketch behavior). Restore the snapshot silently
    // FIRST so the undoable remove command baselines the PRE-EDIT state and
    // Cmd+Z brings the layer back with its original text.
    if (!content) {
      if (session.type === 'create') {
        // Clear signals FIRST to prevent state tearing, then rewind the stack
        // and undo pops the creation step. The session never wrote the slow
        // track, so the frame diffs clean against the place checkpoint — the
        // undo removes the freshly placed layer in one move.
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
        actions.history.rewindTo(session.frameId, session.historyMark);
        actions.history.undo();
      } else {
        if (session.originalSnapshot) {
          actions.updateLayer(session.frameId, session.layerId, session.originalSnapshot);
        }
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
        actions.executeCommand(LayersDrawerAPI.commands.remove.uid, {
          frameId: session.frameId,
          layerId: session.layerId,
        });
      }
      sessionRef.current = null;
      return;
    }

    // ── Has content: measure final bounding ──
    const liveLayerTextData = liveLayer.textData ?? textData!;
    const mode = normalizeBoxMode(liveLayerTextData.boxMode);
    let finalBounding = liveLayer.bounding;
    let finalVisibleShape = liveLayer.visibleShape!;
    let finalCx = liveLayer.cx;
    let finalCy = liveLayer.cy;

    if (mode === 'auto_width' || mode === 'auto_height') {
      const el = editorRef.current;
      if (el) {
        const { w, h } = measureEditorBox(el, activeFrame.camera.k);
        // auto_height keeps its locked width: bounding, visibleShape and the
        // horizontal anchor compensation must all read the same width, or the
        // visible shape outgrows the box and the centre drifts on commit.
        const actualW = mode === 'auto_width' ? w : liveLayer.bounding.w;
        finalBounding = { w: actualW, h };
        finalVisibleShape = asLocalShape({ x: 0, y: 0, w: actualW, h });
        // Align-aware anchor compensation, mirroring the live
        // notifyBoundingChange path: the width change anchors per textAlign
        // (left edge / centre / right edge), height growth anchors the top.
        // This compensates for style changes (fontSize…) that happened without
        // a subsequent input event, so committing never makes the box visibly
        // jump. Same axis-aligned approximation for rotated poses.
        finalCx = compensateCenterX(liveLayer.cx, liveLayer.bounding.w, actualW, liveLayerTextData.align);
        finalCy = compensateCenterY(liveLayer.cy, liveLayer.bounding.h, h);
      }
    }

    // Build final state. Content comes from the DOM (the final measurement);
    // every other textData field from the merged live layer.
    const finalState = {
      cx: finalCx,
      cy: finalCy,
      bounding: finalBounding,
      visibleShape: finalVisibleShape,
      textData: { ...liveLayerTextData, content },
    };

    // ModifySession: dirty gate = session-start snapshot vs the final DOM
    // measurement + draft values (finalState above). The slow track never
    // moved during the session, so the snapshot is compared against what the
    // session actually produced, not against a Redux state polluted by
    // interim writes.
    if (session.type === 'modify' && session.originalSnapshot) {
      const dirty = isSessionDirty(finalState, session.originalSnapshot);
      if (!dirty) {
        // No changes: exit with zero undo impact
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
        actions.setStateSignal(TEXT_OVERLAY_SIGNAL_SESSION_TYPE, null);
        sessionRef.current = null;
        return;
      }

      // Has changes: apply the final state and rebase the checkpoint. The
      // session's LEDGERED writes (per-op panel style commands) already sit in
      // history as their own steps; this rebase folds the remaining RAW
      // interim edits (typing) into one final step on top of them. The old
      // restore-snapshot + fold-into-one-command dance is gone: with
      // edit_start having rebased the checkpoint to the session-start state,
      // the session's writes were ledgered against a valid baseline all along.
      actions.updateLayer(session.frameId, session.layerId, finalState);
      actions.history.commitCheckpoint(session.frameId);
    } else {
      // CreateSession: apply final state and fold the session's raw interim
      // edits (typing) into one final history step. The panel styling done
      // during the session is already ledgered per-op (style commands baseline
      // against the checkpoint the place command established); this rebase
      // records the remaining raw span above it, so undo peels the session
      // apart granularly: style steps first, then the text, then the whole
      // layer (the creation step).
      actions.updateLayer(activeFrame.id, layerId, finalState);
      actions.history.commitCheckpoint(activeFrame.id);
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
        // dispatcher.cancelAll before the editor can commit its own session.
        // Figma standard: Esc commits and exits editing (transitions to layer selected state).
        e.preventDefault();
        e.stopPropagation();
        commitEditing();
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
    [commitEditing],
  );

  // Commit requests from the interaction state machine (two-stage click
  // arbitration): the TextPlaceHandler consumes a canvas click during editing
  // by dispatching this event instead of creating a new layer.
  useEffect(() => {
    const requestCommit = () => commitEditing();
    window.addEventListener(TEXT_OVERLAY_EVT_COMMIT_REQUEST, requestCommit);
    return () => window.removeEventListener(TEXT_OVERLAY_EVT_COMMIT_REQUEST, requestCommit);
  }, [commitEditing]);

  // ─── Undo/redo ownership: the SESSION claims it, not the focus ──────────
  // While a session is live, document-history undo must never fire: the most
  // recent checkpoint is cmd.place (create session) or a pre-session edit
  // (modify session), and popping it under a live session deletes the layer or
  // corrupts state. The historical judge was focus — HotkeyManager yields ⌘Z
  // to the browser only when the caret sits in the contenteditable — but any
  // panel interaction (a colour swatch click) moves focus away, silently
  // handing undo to document history. Ownership follows the SESSION lifecycle
  // instead: this capture-phase listener (window capture runs before any
  // bubble-phase listener) intercepts ⌘Z/⌘Y/⇧⌘Z for the session's whole
  // lifetime. With the caret in the editor it lets the native undo stack
  // through untouched; with focus elsewhere (panel clicks) it refocuses the
  // editor and drives the native stack there, so undo keeps reverting TEXT
  // edits — never the document. Esc is claimed the same way: panel clicks
  // steal focus, and the focus-based Esc arbitration then silently swallowed
  // the key while the user believed they had left the session. Style changes
  // made through the panel inside the session are ledgered per-op (see the
  // CraftDrawer write path); IME composition is excluded, matching the yield
  // rule in HotkeyManager.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const el = editorRef.current;
      if (!el) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        commitEditing();
        return;
      }
      if (!((e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y') && (e.metaKey || e.ctrlKey))) return;
      if (document.activeElement === el) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      el.focus();
      const sel = window.getSelection();
      if (sel) {
        sel.selectAllChildren(el);
        sel.collapseToEnd();
      }
      const redo = e.key.toLowerCase() === 'y' || e.shiftKey;
      document.execCommand(redo ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [editorRef, commitEditing]);

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

  const boxMode = normalizeBoxMode(textData?.boxMode);
  // Fixed mode: vertical position of the content block inside the box comes
  // from the SHARED layout (computeTextLayout) as vAlignOffset — the same
  // offset the GPU renderer bakes into its baselines. Flex centering is NOT
  // used: the contenteditable keeps an invisible trailing line box (the
  // persistent <br>), which flex would center too and push the visible text
  // half a line high. Applied as paddingTop so the contenteditable itself
  // stays a plain block — caret/selection behaviour is untouched.
  // Render-time text view: the slow-track textData with the live DOM content
  // mirrored on top (see liveContent). Style fields stay authoritative from
  // the slow track (panel commands land there); only content differs, and the
  // layout math below (fixed-mode vertical alignment) must solve against what
  // the user is actually typing.
  const liveTextData = textData ? { ...textData, content: liveContent ?? textData.content } : textData;

  let fixedVAlignOffset = 0;
  if (boxMode === 'fixed' && layer && liveTextData) {
    const mc = getEditorMeasureContext();
    if (mc) {
      fixedVAlignOffset = computeTextLayout(
        mc,
        liveTextData,
        liveTextData.boxWidth || layer.bounding.w,
        liveTextData.boxHeight || layer.bounding.h,
      ).vAlignOffset;
    }
  }

  // Calculate initial transform (for SSR/first frame, taken over by useFastSync Ticker subsequently).
  // Mirrors useFastSync: project the layer's full world matrix (incl. rotation/flip)
  // through the camera matrix, so the box is correctly rotated on the very first paint.
  let screenMatrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  if (activeFrame && layer) {
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
  }

  return {
    containerRef,
    editorRef,
    layer,
    textData: liveTextData,
    boxMode,
    fixedVAlignOffset,
    screenMatrix,
    globalCursor,
    handleInput,
    handleKeyDown,
    handleMouseDown,
    commitEditing,
    cancelEditing,
  };
}

