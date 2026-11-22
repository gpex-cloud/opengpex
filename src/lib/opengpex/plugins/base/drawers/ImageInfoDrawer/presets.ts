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

import type { ExportFormat } from './protocols';

import { fitLongEdge, fitShortEdge, fitWithin } from './utils';

/**
 * How a preset derives its export dimensions from the source (or clip-region)
 * dimensions. Scale-only and always aspect-preserving — a preset NEVER crops
 * and NEVER distorts:
 *
 * - `longEdge`: scale so the LONGER source edge equals `value`.
 * - `shortEdge`: scale so the SHORTER source edge equals `value`.
 * - `fitWithin`: scale so the image fits entirely inside the
 *   `width` x `height` box (contain: the limiting factor wins).
 */
export type PresetSize =
  | { kind: 'longEdge'; value: number }
  | { kind: 'shortEdge'; value: number }
  | { kind: 'fitWithin'; width: number; height: number };

/**
 * One quick-save preset in the Save dropdown. A preset item is a ONE-SHOT
 * save: it assembles export params and runs the export immediately through
 * the same encode command as the Save button. It must never write back to
 * the W/H, format or quality controls — those stay exactly as the user left
 * them. V1 is a static table only (no user-defined presets).
 */
export interface ExportPreset {
  /** Stable id, doubles as the menu item value (`preset:<id>`). */
  id: string;
  /** Menu text, e.g. "Save for Sharing". */
  label: string;
  /** Short menu description of what the preset targets. */
  description: string;
  /** Dimension strategy, resolved against the current source aspect. */
  size: PresetSize;
  /** Container format used for this one export. */
  format: ExportFormat;
  /** Encoder quality 1-100 used for this one export. */
  quality: number;
}

/**
 * The V1 static preset table. Values are fixed for V1 (Avatar 512 jpeg q90,
 * Sharing 1080 q85, Banner fit 1280x720 q85). Avatar targets a square avatar
 * slot so it keys on the SHORT edge (a portrait stays portrait, scaled until
 * it fits a 512 square slot); Banner scales to fit inside a 16:9 1280x720
 * cover box; Sharing scales the long edge to the 1080 that social feeds
 * downscale to anyway.
 */
export const EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: 'avatar',
    label: 'Save for Avatar',
    description: 'short edge 512, jpeg q90',
    size: { kind: 'shortEdge', value: 512 },
    format: 'image/jpeg',
    quality: 90,
  },
  {
    id: 'share',
    label: 'Save for Sharing',
    description: 'long edge 1080, jpeg q85',
    size: { kind: 'longEdge', value: 1080 },
    format: 'image/jpeg',
    quality: 85,
  },
  {
    id: 'banner',
    label: 'Save for Banner',
    description: 'fit 1280x720, jpeg q85',
    size: { kind: 'fitWithin', width: 1280, height: 720 },
    format: 'image/jpeg',
    quality: 85,
  },
];

/** Look up a preset by its stable id. Undefined for unknown ids. */
export function getExportPreset(id: string): ExportPreset | undefined {
  return EXPORT_PRESETS.find((p) => p.id === id);
}

/**
 * Resolve a preset's concrete export dimensions for a source rectangle
 * (the full frame, or the clip-region rect when a clip box is active).
 * Pure: same inputs always yield the same rounded, min-1-clamped dims and
 * the aspect ratio is preserved up to integer rounding.
 */
export function resolvePresetDims(
  preset: ExportPreset,
  srcW: number,
  srcH: number,
): { w: number; h: number } {
  const size = preset.size;
  switch (size.kind) {
    case 'longEdge':
      return fitLongEdge(srcW, srcH, size.value);
    case 'shortEdge':
      return fitShortEdge(srcW, srcH, size.value);
    case 'fitWithin':
      return fitWithin(srcW, srcH, size.width, size.height);
  }
}
