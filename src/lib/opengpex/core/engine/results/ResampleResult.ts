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
 * ResampleResult — concrete result type for resample operations.
 *
 * Inherits all behavior from PixelResult base class.
 * Consumption is identical to other result types:
 *   - result.toAsset()     → register in AssetService, auto cache warming
 *   - result.toBlob()      → get the raw resampled blob
 *   - result.toImageData() → get pixel data for inspection
 *
 * No additional domain-specific methods needed for resample.
 */

import { PixelResult } from './PixelResult';

export class ResampleResult extends PixelResult {}
