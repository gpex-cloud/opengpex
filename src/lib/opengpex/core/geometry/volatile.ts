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

import { Layer, VolatileState, Dimensions, LayerPoseOverride } from '@opengpex/editor/core/types';
import { LayerUtils } from '@opengpex/editor/core/layer/LayerUtils';
import { Matrix3x3 } from './matrix';
import { getLayerWorldMatrix, getLayerLocalMatrix } from './operators/transform';

/**
 * [Fast Track] Get layer world matrix in real-time interaction
 */
export function getLayerWorldMatrixVolatile(
  frameId: string,
  layer: Layer,
  v: VolatileState | null,
  extra?: LayerPoseOverride
): Matrix3x3 {
  // 1. Check if the fast-track buffer has overlay properties for this layer (shadow layer)
  const draft = v?.buffered.layers[LayerUtils.getCompositeKey(frameId, layer.id)];
  
  if (draft) {
    // Merge fast-track data
    return getLayerWorldMatrix(layer, {
      cx: draft.cx ?? undefined,
      cy: draft.cy ?? undefined,
      rotation: draft.rotation ?? undefined
    });
  }

  // 2. Check if there are extra corrections on display level (e.g. overall artboard rotation)
  if (extra) {
    return getLayerWorldMatrix(layer, extra);
  }

  // 3. Fallback to slow-track static data
  return getLayerWorldMatrix(layer);
}

/**
 * [Fast Track] Get layer local matrix in real-time interaction
 */
export function getLayerLocalMatrixVolatile(
  frameId: string,
  layer: Layer,
  canvasDim: Dimensions,
  v: VolatileState | null,
  extra?: LayerPoseOverride
): Matrix3x3 {
  const draft = v?.buffered.layers[LayerUtils.getCompositeKey(frameId, layer.id)];
  
  if (draft) {
    return getLayerLocalMatrix(layer, canvasDim, {
      cx: draft.cx ?? undefined,
      cy: draft.cy ?? undefined,
      rotation: draft.rotation ?? undefined
    });
  }

  if (extra) {
    return getLayerLocalMatrix(layer, canvasDim, extra);
  }

  return getLayerLocalMatrix(layer, canvasDim);
}
