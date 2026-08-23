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

import { Layer } from '@opengpex/editor/core/types';

/**
 * LayerUtils: High-frequency pure function toolset for layer operations
 * Provides general layer calculation methods independent of business logic and state management.
 */
export const LayerUtils = {
  /**
   * getCompositeKey: Generates fast-track composite key (frameId:layerId)
   * Used to achieve artboard-level isolation in the flat fast-track cache.
   */
  getCompositeKey(frameId: string, layerId: string): string {
    return `${frameId}:${layerId}`;
  },

  /**
   * mergeLayerDraft: Merges a layer with its fast-track draft
   * Used for high-performance data merging prior to rendering.
   */
  mergeLayerDraft(layer: Layer, draft?: Partial<Layer>): Layer {
    if (!draft) return layer;
    return { ...layer, ...draft };
  }
};
