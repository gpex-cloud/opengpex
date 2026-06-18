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

import { EditorData, Frame, Layer } from '@opengpex/editor/core/types';

/**
 * Returns all frames in their visual order.
 */
export const selectAllFrames = (state: EditorData): Frame[] => {
  return state.frames.order.map(id => state.frames.byId[id]);
};

/**
 * Returns all layers of a frame in their visual order.
 */
export const selectAllLayers = (frame: Frame | null | undefined): Layer[] => {
  if (!frame) return [];
  return frame.layers.order.map(id => frame.layers.byId[id]);
};

/**
 * Returns a specific frame by its ID.
 */
export const selectFrameById = (state: EditorData, id: string): Frame | undefined => {
  return state.frames.byId[id];
};

/**
 * Returns a specific layer by its frame ID and layer ID.
 */
export const selectLayerById = (state: EditorData, frameId: string, layerId: string): Layer | undefined => {
  return state.frames.byId[frameId]?.layers.byId[layerId];
};
