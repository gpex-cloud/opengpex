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
 * usePenHudAnchor: the active pen layer's TRUE box in screen space for the
 * TransformHud framework — derived LIVE every tick (a gesture writes
 * cx/cy/rotation to the fast track, so the merged frame is always the
 * current pose; a gesture-start snapshot would freeze the HUD while the
 * layer moves). The projection pipeline mirrors the historical pen gizmo
 * sync exactly: full world matrix composed with the camera matrix, scale
 * folded into the extents (the HUD container renders as a pure rotation;
 * children keep constant screen size), angle re-derived from the
 * scale-normalized matrix so a flip's mirror does not corrupt the
 * orientation (the gizmo declaration carries the flip flags instead).
 * Host layers only: fragment-triplet sub-layers are engine clones and
 * never anchor a pen HUD.
 */
export function usePenHudAnchor(layerId: string | null) {
  const { geometry } = useEditorServices();

  const getAnchorFrame = useCallback((
    _v: VolatileState,
    f: Frame,
    cam: CameraState,
  ): ScreenRotationBox | null => {
    if (!layerId) return null;
    const layer = f.layers.byId[layerId];
    if (!layer || layer.type !== 'vector' || !layer.penData) return null;
    if (layer.role && layer.role !== 'host') return null;

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
