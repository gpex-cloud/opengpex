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

import { AdjustmentState } from '@opengpex/editor/core/types';

/**
 * Basic utility: Converts adjustments state to a CSS filter string
 */
export function getAdjustmentsData(adj?: AdjustmentState): string {
  if (!adj) return 'none';
  const filters: string[] = [];
  if (adj.brightness !== 100) filters.push(`brightness(${adj.brightness}%)`);
  if (adj.contrast !== 100) filters.push(`contrast(${adj.contrast}%)`);
  if (adj.saturation !== 100) filters.push(`saturate(${adj.saturation}%)`);
  if (adj.hueRotate !== 0) filters.push(`hue-rotate(${adj.hueRotate}deg)`);
  if (adj.blur !== 0) filters.push(`blur(${adj.blur}px)`);
  return filters.length > 0 ? filters.join(' ') : 'none';
}
