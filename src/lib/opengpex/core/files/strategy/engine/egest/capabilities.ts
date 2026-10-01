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
 * Egest capability map — the single source of truth for the Egest constraint
 * solver (`resolveEgestDecision`).
 *
 * WHY A SEPARATE ENGINE FILE
 * --------------------------
 * The Egest counterpart to the Ingest pattern-matcher. Ingest faces the outside
 * world's "empirical special cases" (7 heterogeneous decode channels, a 26-row
 * first-match rule table); Egest faces the system's "algebraically closed
 * constraints" — only 3 orthogonal physical channels and a one-shot capability
 * lookup + one-way channel derivation. This table is that lookup's only data.
 *
 * THREE PHYSICAL CHANNELS
 * -----------------------
 * - `'canvas-8'`: 8-bit terminal encode → gamut-TAGGED `OffscreenCanvas` →
 *   `createImageBitmap` → the browser / MozJPEG encoder. Carries only the two
 *   gamuts a browser `PredefinedColorSpace` can represent (`srgb`, `display-p3`).
 * - `'raw-8'`: 8-bit naked `Uint8Array` straight to the vips PNG/TIFF encoder,
 *   NO canvas hop. Carries the FULL gamut set (incl. adobe-rgb / prophoto-rgb)
 *   at 8-bit — the lane that lets a wide-gamut 8-bit export avoid both the P3
 *   downgrade and the file-size doubling of a forced 16-bit path.
 * - `'raw-16'`: 16-bit naked `Uint16Array` straight to vips. Full gamut set at
 *   professional 16-bit precision.
 *
 * `supportedGamuts` is the container's authoritative gamut envelope: what the
 * container can hold already subsumes the format's total in-system channel
 * capability, so `resolveEgestDecision` needs no separate "lane can carry it"
 * gate — the three-gate clamp is gone.
 */

import type { SourceFormat } from '../../../types';
import type { GamutId } from '@opengpex/editor/core/types';

/** The physical encode lane the pixels travel. */
export type EgestChannel = 'canvas-8' | 'raw-8' | 'raw-16';

/**
 * The objective, per-container EXPORT capability facts — ICC, channel and gamut
 * constraints unified into one table.
 *
 * `[!WARNING]` `supportedGamuts` must never be `[]` — `heic`/`raw` keep `['srgb']`
 * as a harmless fallback (they never reach the clamp anyway). It is
 * `supportedChannels: []` that marks "cannot encode this format at all", and
 * `resolveEgestDecision` THROWS on it rather than silently degrading to some
 * default container.
 */
export interface FormatEgestCapability {
  /** Which physical encode lane(s) this container's own encoder can accept. */
  readonly supportedChannels: readonly EgestChannel[];
  /** The widest bit depth the container's encoder can write. */
  readonly maxBitDepth: 8 | 16;
  /** Every gamut the container can hold without corrupting/reinterpreting pixels. */
  readonly supportedGamuts: readonly GamutId[];
  /** Whether the container has a place to put an ICC profile at all. */
  readonly supportsIccEmbed: boolean;
}

export const FORMAT_EGEST_CAPABILITIES: Record<SourceFormat, FormatEgestCapability> = {
  // ─── Full-channel professional containers: canvas-8, raw-8 AND raw-16 ───
  png:  { supportedChannels: ['canvas-8', 'raw-8', 'raw-16'], maxBitDepth: 16, supportedGamuts: ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb'], supportsIccEmbed: true },
  tiff: { supportedChannels: ['canvas-8', 'raw-8', 'raw-16'], maxBitDepth: 16, supportedGamuts: ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb'], supportsIccEmbed: true },

  // ─── Canvas-first containers: depend on the browser / MozJPEG encoder ───
  jpeg: { supportedChannels: ['canvas-8'], maxBitDepth: 8, supportedGamuts: ['srgb', 'display-p3'], supportsIccEmbed: true },
  webp: { supportedChannels: ['canvas-8'], maxBitDepth: 8, supportedGamuts: ['srgb', 'display-p3'], supportsIccEmbed: true },
  // jsquash's AVIF encoder has no ICC-embed API — unlike jpeg/webp/tiff/png,
  // `supportsIccEmbed` is a real physical `false` here, not just "off by default".
  avif: { supportedChannels: ['canvas-8'], maxBitDepth: 8, supportedGamuts: ['srgb', 'display-p3'], supportsIccEmbed: false },

  // ─── Legacy containers fixed to sRGB (no ICC, no wide gamut at all) ───
  bmp:  { supportedChannels: ['canvas-8'], maxBitDepth: 8, supportedGamuts: ['srgb'], supportsIccEmbed: false },
  gif:  { supportedChannels: ['canvas-8'], maxBitDepth: 8, supportedGamuts: ['srgb'], supportsIccEmbed: false },
  svg:  { supportedChannels: ['canvas-8'], maxBitDepth: 8, supportedGamuts: ['srgb'], supportsIccEmbed: false },
  eps:  { supportedChannels: ['canvas-8'], maxBitDepth: 8, supportedGamuts: ['srgb'], supportsIccEmbed: false },

  // ─── Decode-only formats: no encoder exists, hence no channel at all ───
  heic: { supportedChannels: [], maxBitDepth: 8, supportedGamuts: ['srgb'], supportsIccEmbed: false },
  raw:  { supportedChannels: [], maxBitDepth: 8, supportedGamuts: ['srgb'], supportsIccEmbed: false },

  unknown: { supportedChannels: ['canvas-8'], maxBitDepth: 8, supportedGamuts: ['srgb'], supportsIccEmbed: false },
};
