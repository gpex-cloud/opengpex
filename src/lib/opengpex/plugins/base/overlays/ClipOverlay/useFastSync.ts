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

import { useRef } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync, useFastRectSync, useFastSvgGroupSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { LocalRect } from '@opengpex/editor/core/types';

/**
 * useCropDimSync: Fast track Hook dedicated to synchronizing selection dimension display
 */
export function useCropDimSync(
  isActive: boolean,
  isReCanvas: boolean
) {
  const dimLabelRef = useRef<HTMLSpanElement>(null);

  useFastSync(dimLabelRef, isActive, (_v, f) => {
    const currentShape = isReCanvas ? f.canvasCropBox : f.imageCropBox;
    const currentBox = currentShape.rect;

    if (dimLabelRef.current) {
      dimLabelRef.current.textContent = `${Math.round(currentBox.w)} × ${Math.round(currentBox.h)}`;
    }
  });

  return { dimLabelRef };
}

/**
 * useCropBoxSync: Selection box screen-space synchronization master (simplified via standard operators)
 */
export function useCropBoxSync(
  ref: React.RefObject<HTMLElement | null>,
  cropBox: LocalRect,
  isActive: boolean,
  isReCanvas: boolean,
  showGridThreshold: number | null
) {
  const { geometry } = useEditorServices();
  const groupRef = useRef<SVGGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const guidesRef = useRef<HTMLDivElement>(null);
  const lastDim = useRef<{ w: number; h: number; type: string; antiAliased?: boolean; el: SVGElement | null }>({ w: -1, h: -1, type: '', el: null });
  useFastRectSync(ref, isActive, {
    selector: (_v, f) => {
      const shape = isReCanvas ? f.canvasCropBox : f.imageCropBox;
      return shape.rect;
    },
    space: 'local'
  });

  useFastSvgGroupSync(groupRef, isActive, {
    selector: (_v, f) => {
      const shape = isReCanvas ? f.canvasCropBox : f.imageCropBox;
      return shape.rect;
    },
    space: 'local'
  });

  useFastSync(pathRef, isActive, (_v, f, cam) => {
    const shape = isReCanvas ? f.canvasCropBox : f.imageCropBox;
    const box = shape.rect;

    // Toggle guides instantly in fast-track
    if (guidesRef.current) {
      const k = geometry.getScale(f, cam);
      if (showGridThreshold !== null && k >= showGridThreshold) {
        guidesRef.current.style.opacity = '0';
      } else {
        guidesRef.current.style.opacity = '0.2';
      }
    }

    // Update the inner path data only if local dimensions change
    if (
      box.w !== lastDim.current.w ||
      box.h !== lastDim.current.h ||
      shape.type !== lastDim.current.type ||
      shape.antiAliased !== lastDim.current.antiAliased ||
      pathRef.current !== lastDim.current.el
    ) {
      lastDim.current = { w: box.w, h: box.h, type: shape.type, antiAliased: shape.antiAliased, el: pathRef.current };

      if (pathRef.current) {
        const d = shape.antiAliased === false
          ? geometry.shape.getStairedSvgPath(shape)
          : geometry.shape.getSmoothSvgPath(shape);
        pathRef.current.setAttribute('d', d);
      }
    }
  });

  return { syncStyle: {}, groupRef, pathRef, guidesRef };
}

