/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { useCallback } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import type { CameraState, Frame, ScreenRotationBox, VolatileState } from '@opengpex/editor/core/types';

/**
 * useMarkerHudAnchor: the active marker layer's TRUE box in screen space
 * for the TransformHud framework — derived LIVE every tick (a gesture
 * writes cx/cy/rotation to the fast track, so the merged frame is always
 * the current pose; a gesture-start snapshot would freeze the HUD while
 * the marker moves).
 *
 * The box is the marker's bounding rect (layer-local top-left at 0,0)
 * projected through the layer's FULL world matrix composed with the camera
 * matrix — the identical pipeline the selection fast-sync uses, so the HUD
 * container and the historical box are equivalent presentations. Scale is
 * folded into the extents (the container renders as a pure rotation;
 * children keep constant screen size); the angle is re-derived from the
 * scale-normalized matrix so a flip's mirror does not corrupt the
 * orientation (the gizmo declaration carries the flip flags instead).
 */
export function useMarkerHudAnchor(layerId: string | null) {
  const { geometry } = useEditorServices();

  const getAnchorFrame = useCallback((
    _v: VolatileState,
    f: Frame,
    cam: CameraState,
  ): ScreenRotationBox | null => {
    if (!layerId) return null;
    const layer = f.layers.byId[layerId];
    if (!layer || layer.type !== 'vector' || !layer.markerData) return null;

    const worldMatrix = geometry.transform.getLayerWorldMatrix(layer);
    const viewMatrix = geometry.camera.getCameraMatrix(f, cam);
    const matrix = {
      ...viewMatrix.multiply(worldMatrix),
      w: layer.bounding.w,
      h: layer.bounding.h,
    };

    const { scaleX, scaleY } = geometry.transform.decomposeMatrix(matrix);
    const sx = scaleX || 0.001;
    return {
      x: matrix.tx,
      y: matrix.ty,
      w: layer.bounding.w * scaleX,
      h: layer.bounding.h * scaleY,
      // Scale-normalized u-axis direction: pure orientation, camera
      // rotation already folded in.
      angleRad: Math.atan2(matrix.b / sx, matrix.a / sx),
    };
  }, [geometry, layerId]);

  return { getAnchorFrame };
}
