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

import { useEditorServices } from '@opengpex/editor/core/context';
import { useFastMatrixSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { Layer } from '@opengpex/editor/core/types';

/**
 * useLayerOverlaySync: Layer outline screen-space synchronization.
 * Responsible for projecting the layer's World Matrix to screen space every frame and directly manipulating DOM.
 */
export function useLayerOverlaySync(
  ref: React.RefObject<HTMLElement | null>,
  labelRef: React.RefObject<HTMLElement | null>,
  layer: Layer,
  isActive: boolean
) {
  const { geometry } = useEditorServices();

  useFastMatrixSync(ref, isActive, {
    labelRef,
    selector: (v, f, cam) => {
      // f.layers is already deep-merged by the underlying useFastSync hook
      const latestLayer = f.layers.byId[layer.id] || layer;

      // 1. Execute pure geometric operations
      const worldMatrix = geometry.transform.getLayerWorldMatrix(latestLayer);
      const viewMatrix = geometry.camera.getCameraMatrix(f, cam);
      const screenMatrix = viewMatrix.multiply(worldMatrix);

      // 2. Consider local offset from visibleRect
      const rect = latestLayer.visibleShape?.rect || { x: 0, y: 0, w: latestLayer.bounding.w, h: latestLayer.bounding.h };
      const fragmentMatrix = screenMatrix.multiply(geometry.Matrix.translate(rect.x, rect.y));

      // 3. Attach dimension info to the matrix object for the synchronizer
      return { ...fragmentMatrix, w: rect.w, h: rect.h };
    }
  });

  return { sync: () => { } };
}
