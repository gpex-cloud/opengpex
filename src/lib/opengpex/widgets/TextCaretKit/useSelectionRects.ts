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
  resolveSelectionRects,
  getLiveMatrixFromOffsetParent,
  type TextSelectionRect,
} from './geometry';

export interface UseSelectionRectsOptions {
  editorRef: RefObject<HTMLElement | null>;
  fontSize: number;
  lineHeight?: number;
  getLiveMatrix?: () => DOMMatrixReadOnly | null;
}

/**
 * Track the active text selection of a contenteditable host as a list of
 * container-local highlight rectangles. Re-resolves on selection changes and
 * editor interactions.
 */
export function useSelectionRects({
  editorRef,
  fontSize,
  lineHeight = 1.4,
  getLiveMatrix,
}: UseSelectionRectsOptions): TextSelectionRect[] {
  const [rects, setRects] = useState<TextSelectionRect[]>([]);

  const updateSelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      setRects([]);
      return;
    }
    const resolved = resolveSelectionRects(editor, {
      fontSize,
      lineHeight,
      getLiveMatrix:
        getLiveMatrix ??
        (() => (editor ? getLiveMatrixFromOffsetParent(editor) : null)),
    });
    setRects(resolved);
  }, [editorRef, fontSize, lineHeight, getLiveMatrix]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const handleAction = () => {
      requestAnimationFrame(updateSelection);
    };

    const handleSelectionChange = () => {
      updateSelection();
    };

    editor.addEventListener('focus', handleAction);
    editor.addEventListener('blur', handleAction);
    editor.addEventListener('input', handleAction);
    editor.addEventListener('keydown', handleAction);
    editor.addEventListener('keyup', handleAction);
    editor.addEventListener('mousedown', handleAction);
    editor.addEventListener('mouseup', handleAction);
    document.addEventListener('selectionchange', handleSelectionChange);

    updateSelection();

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
  }, [editorRef, updateSelection]);

  return rects;
}
