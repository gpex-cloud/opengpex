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

/**
 * RasterizeResult — concrete result type for rasterize operations (Phase 6).
 *
 * Used for:
 *   - Text layer → bitmap rasterization
 *   - Polygon → alpha mask rasterization
 *
 * Standard consumption:
 *   - result.toAsset()     → register in AssetService, auto cache warming
 *   - result.toBlob()      → get the raw rasterized blob
 *   - result.toImageData() → get pixel data for CPU inspection
 */

import { PixelResult } from './PixelResult';
import type { PixelResultData } from '../protocol/results';
import type { AssetService } from '@opengpex/editor/core/types';

export class RasterizeResult extends PixelResult {
  constructor(data: PixelResultData, assets: AssetService) {
    super(data, assets);
  }
}
