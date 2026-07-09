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
 * PixelService.render lane detection — extracted for testability.
 *
 * See docs/opengpex/20260710_rendering_and_export_pipeline_overview.md §3.2.
 *
 *   Lane A = 16-bit single-layer direct (vips one-shot decode+encode)
 *   Lane B = 16-bit multi-layer composite (vips composite+encode)
 *   Lane C = 8-bit standard (engine worker + files.encode / external encoder / raw bitmap)
 */

import type { Frame, LocalShape, RenderToBlobOptions } from '@opengpex/editor/core/types';

export type Lane = 'lane-a' | 'lane-b' | 'lane-c';

/** Formats supported by the vips-native lanes (Lane A / Lane B). */
const RAW_FORMATS = new Set(['image/tiff', 'image/png']);

/**
 * Probe protocol: how to test whether a given assetId has a 16-bit raw source available.
 * We inject this instead of importing assetStore directly, so tests can stub it cleanly.
 */
export interface HasRawProbe {
  (assetId: string): Promise<boolean> | boolean;
}

/**
 * Detects which export lane to use for a given (frame, shape, options) triple.
 *
 * Pure(ish): only invokes `hasRaw` probe (may be async). No side effects.
 * Ordering of checks matters — see docs.
 */
export async function detectLane(
  frame: Frame,
  shape: LocalShape,
  opts: RenderToBlobOptions,
  hasRaw: HasRawProbe,
): Promise<Lane> {
  // ── Fast path: raw bitmap output (used by cache warmup, AsyncFilterCache, etc.)
  if (opts.format === 'raw') return 'lane-c';

  // ── 16-bit lanes only viable when user opted in AND format supports raw encoding AND shape is rect
  if (opts.exportBitDepth !== 16) return 'lane-c';
  if (!opts.format || !RAW_FORMATS.has(opts.format)) return 'lane-c';
  if (shape.type !== 'rect') return 'lane-c';

  // ── Visible content layers (host non-hidden)
  const visibleIds = frame.layers.order.filter(id => {
    const l = frame.layers.byId[id];
    return !l.hostId && l.visible !== false;
  });
  if (visibleIds.length === 0) return 'lane-c';

  // ── Lane A eligibility: exactly one visible layer + source bit depth > 8 + has raw
  if (visibleIds.length === 1) {
    const layer = frame.layers.byId[visibleIds[0]];
    const bitDepth = (layer?.metadata?.imageMetadata as { bitDepth?: number } | undefined)?.bitDepth ?? 8;
    if (bitDepth > 8 && layer.assetId) {
      if (await hasRaw(layer.assetId)) return 'lane-a';
    }
  }

  // ── Lane B eligibility: ≥1 visible layer has raw source → multi-layer 16-bit composite
  for (const id of visibleIds) {
    const layer = frame.layers.byId[id];
    if (!layer.assetId) continue;
    if (await hasRaw(layer.assetId)) return 'lane-b';
  }

  return 'lane-c';
}
