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
 * 26-row complete decision matrix rule table.
 *
 * Rules are declared in priority order (row 1 → row 26), returning the first match via `./matcher.ts`.
 * CMYK (rule 25) is split into two rules with id=25 by bitDepth (8/16) to keep
 * `DecisionAction.dataFormat` statically typed.
 *
 * @module core/files/strategy/engine/rules
 */

import type { DecisionRule } from './types';

export const INGEST_DECISION_RULES: readonly DecisionRule[] = [
  // ── 1. JPEG ─────────────────────────────────────────────────────────────
  {
    id: 1,
    condition: {
      format: 'jpeg',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'JPEG 8-bit standard (srgb/p3) browser passthrough',
    },
  },
  {
    id: 2,
    condition: {
      format: 'jpeg',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'wide-gamut-8',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'JPEG 8-bit wide-gamut lift to f16 and fold proxy',
    },
  },

  // ── 2. WebP ─────────────────────────────────────────────────────────────
  {
    id: 3,
    condition: {
      format: 'webp',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'WebP 8-bit standard passthrough',
    },
  },
  {
    id: 4,
    condition: {
      format: 'webp',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'wide-gamut-8',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'WebP 8-bit wide-gamut lift to f16',
    },
  },

  // ── 3. PNG ──────────────────────────────────────────────────────────────
  {
    id: 5,
    condition: {
      format: 'png',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'explicit', // Browser ignores eXIf
      description: 'PNG 8-bit standard passthrough',
    },
  },
  {
    id: 6,
    condition: {
      format: 'png',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'wide-gamut-8',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'PNG 8-bit wide-gamut',
    },
  },
  {
    id: 7,
    condition: {
      format: 'png',
      bitDepth: 16,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'srgb-trc',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'PNG 16-bit standard high-precision',
    },
  },
  {
    id: 8,
    condition: {
      format: 'png',
      bitDepth: 16,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'PNG 16-bit wide-gamut high-precision degamma',
    },
  },

  // ── 4. TIFF ─────────────────────────────────────────────────────────────
  {
    id: 9,
    condition: {
      format: 'tiff',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'TIFF 8-bit standard (retain original file)',
    },
  },
  {
    id: 10,
    condition: {
      format: 'tiff',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'TIFF 8-bit wide-gamut',
    },
  },
  {
    id: 11,
    condition: {
      format: 'tiff',
      bitDepth: 16,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'srgb-trc',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'TIFF 16-bit standard high-precision',
    },
  },
  {
    id: 12,
    condition: {
      format: 'tiff',
      bitDepth: 16,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
    },
    action: {
      decodeChannel: 'vips',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'TIFF 16-bit wide-gamut high-precision',
    },
  },
  {
    id: 13,
    condition: {
      format: 'tiff',
      bitDepth: (d) => d >= 32,
      colorSpace: '*',
    },
    action: {
      decodeChannel: 'vips',
      trc: 'linear',
      dataFormat: 'rgba32float',
      applyOrientation: 'explicit',
      description: 'TIFF 32-bit float passthrough',
    },
  },

  // ── 5. Camera RAW ────────────────────────────────────────────────────────
  {
    id: 14,
    condition: {
      format: 'raw',
      bitDepth: '*',
      colorSpace: '*',
    },
    action: {
      decodeChannel: 'libraw',
      trc: 'linear',
      dataFormat: 'rgba16float',
      renderIntent: 'filmic',
      applyOrientation: 'auto',
      description: 'Camera RAW native linear restoration',
    },
  },

  // ── 6. AVIF ─────────────────────────────────────────────────────────────
  // Note: AVIF >8-bit is clamped to 8-bit in pre-processing, no special branch needed
  {
    id: 15,
    condition: {
      format: 'avif',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'AVIF 8-bit standard passthrough',
    },
  },
  {
    id: 17,
    condition: {
      format: 'avif',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'wide-gamut-8',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'AVIF 8-bit wide-gamut',
    },
  },

  // ── 7. HEIC ─────────────────────────────────────────────────────────────
  {
    id: 19,
    condition: {
      format: 'heic',
      bitDepth: 8,
      colorSpace: ['srgb', 'display-p3'],
    },
    action: {
      decodeChannel: 'heic-to',
      trc: 'srgb-trc',
      applyOrientation: 'auto',
      description: 'HEIC 8-bit standard transcode',
    },
  },
  {
    id: 20,
    condition: {
      format: 'heic',
      bitDepth: 8,
      colorSpace: ['adobe-rgb', 'prophoto-rgb'],
    },
    action: {
      decodeChannel: 'heic-to',
      trc: 'linear',
      dataFormat: 'rgba16float',
      applyOrientation: 'auto',
      description: 'HEIC 8-bit wide-gamut transcode',
    },
  },

  // ── 8. BMP / GIF / Vector ───────────────────────────────────────────────
  {
    id: 21,
    condition: {
      format: 'bmp',
      bitDepth: 8,
      colorSpace: 'srgb',
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'none',
      description: 'BMP forced sRGB passthrough',
    },
  },
  {
    id: 22,
    condition: {
      format: 'gif',
      bitDepth: 8,
      colorSpace: 'srgb',
      isMultiFrame: false,
    },
    action: {
      decodeChannel: 'image-bitmap',
      trc: 'srgb-trc',
      applyOrientation: 'none',
      description: 'GIF single-frame static passthrough',
    },
  },
  {
    id: 23,
    condition: {
      format: 'gif',
      bitDepth: 8,
      colorSpace: 'srgb',
      isMultiFrame: true,
    },
    action: {
      decodeChannel: 'gifuct',
      trc: 'srgb-trc',
      applyOrientation: 'none',
      description: 'GIF multi-frame parse frame-by-frame',
    },
  },
  {
    id: 24,
    condition: {
      format: ['svg', 'eps'],
      bitDepth: '*',
      colorSpace: '*',
    },
    action: {
      decodeChannel: 'vector',
      trc: 'srgb-trc',
      applyOrientation: 'none',
      description: 'Vector format 1:1 rasterization proxy',
    },
  },

  // ── 9. Special color modes (CMYK & unrecognized) ──────────────────────────
  // CMYK is split into two rules with id=25 by bitDepth (8-bit / 16-bit) to
  // keep `dataFormat` statically typed:
  {
    id: 25,
    condition: {
      format: '*',
      bitDepth: 8,
      colorSpace: 'cmyk',
    },
    action: {
      decodeChannel: 'vips-icc',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'CMYK 8-bit convert to sRGB via ICC engine',
    },
  },
  {
    id: 25,
    condition: {
      format: '*',
      bitDepth: 16,
      colorSpace: 'cmyk',
    },
    action: {
      decodeChannel: 'vips-icc',
      trc: 'srgb-trc',
      dataFormat: 'rgba16float',
      applyOrientation: 'explicit',
      description: 'CMYK 16-bit convert to sRGB via ICC engine (preserve depth)',
    },
  },

  // ── 10. Fallback terminus (Unsupported) ──────────────────────────────────
  {
    id: 26,
    condition: {
      format: '*',
      bitDepth: '*',
      colorSpace: '*',
      isMultiFrame: '*',
    },
    action: {
      decodeChannel: 'unsupported',
      trc: 'srgb-trc',
      applyOrientation: 'explicit',
      description: 'Unsupported or sub-8-bit fallback',
    },
  },
];
