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

import React from 'react';
import { useTextOverlayState } from '../hooks';
import { InlineTextEditor } from './InlineTextEditor';
import { PlaceMarquee } from './PlaceMarquee';
import { PreEditFrame } from './PreEditFrame';

/**
 * TextOverlayMain: Text overlay main component
 *
 * Renders based on state:
 * - editing_text_layer_id has value -> renders InlineTextEditor
 * - Pre-edit: the active text layer's self-drawn crop-mark frame
 *   (PreEditFrame — corners/edge ticks are the resize handles) plus the drag
 *   marquee preview; the marquee self-hides via the volatile transient
 *   (no per-move React updates).
 */
export const TextOverlayMain = React.memo(function TextOverlayMain() {
  const { activeFrame, activeCraft, editingLayerId, layerExists } =
    useTextOverlayState();

  // Editing state: render InlineTextEditor
  if (editingLayerId && layerExists && activeFrame) {
    return <InlineTextEditor layerId={editingLayerId} />;
  }

  // Pre-editing state: self-drawn active-layer frame + marquee watcher
  if (activeCraft === 'text' && activeFrame) {
    return (
      <>
        <PreEditFrame />
        <PlaceMarquee />
      </>
    );
  }

  return null;
});

export { BoxCorners, type BoxCornersProps } from './BoxCorners';
export { InlineTextEditor, type InlineTextEditorProps } from './InlineTextEditor';
export { PlaceMarquee };
export { PreEditFrame };
