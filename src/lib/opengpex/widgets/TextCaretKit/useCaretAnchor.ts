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

import { useState, useEffect, useCallback, type RefObject } from 'react';
import {
  resolveCaretAnchor,
  getLiveMatrixFromOffsetParent,
  type CaretAnchor,
} from './geometry';

export interface UseCaretAnchorOptions {
  editorRef: RefObject<HTMLElement | null>;
  fontSize: number;
  lineHeight?: number;
  verticalAlignOffset?: number;
  /** Content padding for the start-snapping fallback (defaults to 0,0). */
  startPadding?: { x: number; y: number };
  /**
   * Live container-local→viewport matrix provider. Defaults to reading the
   * editor's offsetParent computed transform — the convention for hosts whose
   * container is moved by a direct-DOM ticker. Inject another provider when
   * the host positions itself differently.
   */
  getLiveMatrix?: () => DOMMatrixReadOnly | null;
}

export interface UseCaretAnchorResult {
  /** Current caret anchor, or null when no caret should be rendered. */
  anchor: CaretAnchor | null;
  /**
   * Bumps on every user action (input/keys/pointer) so the caret bar can
   * restart its blink animation on interaction.
   */
  actionKey: number;
}

/**
 * Track the caret position of a contenteditable host as a container-local
 * anchor. Re-resolves on selection changes and editor interactions; the
 * anchor is camera-invariant (it lives in the container's coordinate space),
 * so the host can move/zoom the container freely without re-running this.
 */
export function useCaretAnchor({
  editorRef,
  fontSize,
  lineHeight = 1.4,
  verticalAlignOffset = 0,
  startPadding = { x: 0, y: 0 },
  getLiveMatrix,
}: UseCaretAnchorOptions): UseCaretAnchorResult {
  const [anchor, setAnchor] = useState<CaretAnchor | null>(null);
  const [actionKey, setActionKey] = useState(0);

  const updateCaret = useCallback(() => {
    const editor = editorRef.current;
    const resolution = resolveCaretAnchor(editor, {
      fontSize,
      lineHeight,
      verticalAlignOffset,
      startPadding,
      getLiveMatrix: getLiveMatrix ?? (() => (editor ? getLiveMatrixFromOffsetParent(editor) : null)),
    });
    if (resolution.kind === 'keepPrevious') return;
    setAnchor(resolution.kind === 'visible' ? resolution.anchor : null);
  }, [editorRef, fontSize, lineHeight, verticalAlignOffset, startPadding, getLiveMatrix]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const handleAction = () => {
      setActionKey((k) => (k + 1) % 10000);
      requestAnimationFrame(updateCaret);
    };

    const handleSelectionChange = () => {
      updateCaret();
    };

    editor.addEventListener('focus', handleAction);
    editor.addEventListener('blur', handleAction);
    editor.addEventListener('input', handleAction);
    editor.addEventListener('keydown', handleAction);
    editor.addEventListener('keyup', handleAction);
    editor.addEventListener('mousedown', handleAction);
    editor.addEventListener('mouseup', handleAction);
    document.addEventListener('selectionchange', handleSelectionChange);

    // Initial update
    updateCaret();

    return () => {
      editor.removeEventListener('focus', handleAction);
      editor.removeEventListener('blur', handleAction);
      editor.removeEventListener('input', handleAction);
      editor.removeEventListener('keydown', handleAction);
      editor.removeEventListener('keyup', handleAction);
      editor.removeEventListener('mousedown', handleAction);
      editor.removeEventListener('mouseup', handleAction);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [editorRef, updateCaret]);

  return { anchor, actionKey };
}
