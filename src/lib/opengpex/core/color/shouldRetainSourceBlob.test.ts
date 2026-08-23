/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Unit tests for shouldRetainSourceBlob().
 *
 * Tests the three retention policies:
 * - 'always'           — RAW format always retains
 * - 'never'            — BMP/GIF/SVG/EPS never retain
 * - 'on-fidelity-loss' — PNG/JPEG/WebP/AVIF/TIFF retain when precision or gamut degrades
 *
 * The function consolidates sourceBlob retention logic that was previously
 * scattered across individual handlers.
 */

import { describe, it, expect } from 'vitest';
import { shouldRetainSourceBlob } from './ColorPipeline';

// ═══════════════════════════════════════════════════════════════════════════════
// sourceBlobRetention: 'always' (RAW format)
// ═══════════════════════════════════════════════════════════════════════════════

describe('shouldRetainSourceBlob — always (RAW)', () => {
  it('always retains regardless of metadata', () => {
    expect(shouldRetainSourceBlob('raw', {}, 'srgb')).toBe(true);
    expect(shouldRetainSourceBlob('raw', { bitDepth: 8, colorSpace: 'srgb' }, 'srgb')).toBe(true);
    expect(shouldRetainSourceBlob('raw', { bitDepth: 14, colorSpace: 'prophoto-rgb' }, 'display-p3')).toBe(true);
  });

  it('retains even with 8-bit sRGB metadata (pipeline can represent it but RAW always retains)', () => {
    expect(shouldRetainSourceBlob('raw', { bitDepth: 8, colorSpace: 'srgb' }, 'srgb')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sourceBlobRetention: 'never' (BMP, GIF, SVG, EPS, unknown)
// ═══════════════════════════════════════════════════════════════════════════════

describe('shouldRetainSourceBlob — never (BMP/GIF/SVG/EPS)', () => {
  it('never retains for BMP regardless of metadata', () => {
    expect(shouldRetainSourceBlob('bmp', {}, 'srgb')).toBe(false);
    expect(shouldRetainSourceBlob('bmp', { bitDepth: 8, colorSpace: 'srgb' }, 'srgb')).toBe(false);
  });

  it('never retains for GIF', () => {
    expect(shouldRetainSourceBlob('gif', {}, 'srgb')).toBe(false);
  });

  it('never retains for SVG', () => {
    expect(shouldRetainSourceBlob('svg', {}, 'srgb')).toBe(false);
  });

  it('never retains for EPS', () => {
    expect(shouldRetainSourceBlob('eps', {}, 'srgb')).toBe(false);
  });

  it('never retains for unknown format', () => {
    expect(shouldRetainSourceBlob('unknown', {}, 'srgb')).toBe(false);
  });

  it('never retains even with high bit depth (format cannot carry that anyway)', () => {
    // Even if somehow metadata claims high bit depth, 'never' means never
    expect(shouldRetainSourceBlob('bmp', { bitDepth: 16 }, 'srgb')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sourceBlobRetention: 'on-fidelity-loss' (PNG, JPEG, WebP, AVIF, TIFF)
// ═══════════════════════════════════════════════════════════════════════════════

describe('shouldRetainSourceBlob — on-fidelity-loss', () => {
  // ── No retention needed (lossless representation in pipeline) ──

  describe('no retention when pipeline can fully represent the source', () => {
    it('8-bit sRGB PNG — pipeline represents losslessly', () => {
      expect(shouldRetainSourceBlob('png', { bitDepth: 8, colorSpace: 'srgb' }, 'srgb')).toBe(false);
    });

    it('8-bit Display P3 PNG — pipeline represents losslessly in P3 frame', () => {
      expect(shouldRetainSourceBlob('png', { bitDepth: 8, colorSpace: 'display-p3' }, 'display-p3')).toBe(false);
    });

    it('8-bit sRGB JPEG — pipeline represents losslessly', () => {
      expect(shouldRetainSourceBlob('jpeg', { bitDepth: 8, colorSpace: 'srgb' }, 'srgb')).toBe(false);
    });

    it('8-bit sRGB WebP — pipeline represents losslessly', () => {
      expect(shouldRetainSourceBlob('webp', { bitDepth: 8, colorSpace: 'srgb' }, 'srgb')).toBe(false);
    });

    it('no metadata at all — assume no loss', () => {
      expect(shouldRetainSourceBlob('png', {}, 'srgb')).toBe(false);
    });

    it('bitDepth undefined but colorSpace is srgb — no loss', () => {
      expect(shouldRetainSourceBlob('jpeg', { colorSpace: 'srgb' }, 'srgb')).toBe(false);
    });
  });

  // ── Precision degradation: bitDepth > 8 ──

  describe('retains when bitDepth > 8 (precision degradation)', () => {
    it('16-bit sRGB PNG — retains due to precision loss', () => {
      expect(shouldRetainSourceBlob('png', { bitDepth: 16, colorSpace: 'srgb' }, 'srgb')).toBe(true);
    });

    it('16-bit P3 PNG — retains due to precision loss', () => {
      expect(shouldRetainSourceBlob('png', { bitDepth: 16, colorSpace: 'display-p3' }, 'display-p3')).toBe(true);
    });

    it('16-bit sRGB TIFF — retains', () => {
      expect(shouldRetainSourceBlob('tiff', { bitDepth: 16, colorSpace: 'srgb' }, 'srgb')).toBe(true);
    });

    it('32-bit floating-point TIFF — retains', () => {
      expect(shouldRetainSourceBlob('tiff', { bitDepth: 32, colorSpace: 'srgb' }, 'srgb')).toBe(true);
    });

    it('10-bit AVIF — retains', () => {
      expect(shouldRetainSourceBlob('avif', { bitDepth: 10, colorSpace: 'srgb' }, 'srgb')).toBe(true);
    });

    it('12-bit AVIF — retains', () => {
      expect(shouldRetainSourceBlob('avif', { bitDepth: 12, colorSpace: 'display-p3' }, 'display-p3')).toBe(true);
    });
  });

  // ── Gamut degradation: source CS ≠ sRGB and ≠ frameColorSpace ──

  describe('retains when source gamut exceeds frame working space', () => {
    it('AdobeRGB → P3 frame — ~2% gamut loss, retains', () => {
      expect(shouldRetainSourceBlob('jpeg', { bitDepth: 8, colorSpace: 'adobe-rgb' }, 'display-p3')).toBe(true);
    });

    it('ProPhoto → P3 frame — ~30% gamut loss, retains', () => {
      expect(shouldRetainSourceBlob('tiff', { bitDepth: 8, colorSpace: 'prophoto-rgb' }, 'display-p3')).toBe(true);
    });

    it('custom ICC (unknown) → sRGB frame — gamut loss, retains', () => {
      expect(shouldRetainSourceBlob('png', { bitDepth: 8, colorSpace: 'unknown' }, 'srgb')).toBe(true);
    });

    it('CMYK → sRGB frame — gamut loss, retains', () => {
      expect(shouldRetainSourceBlob('jpeg', { bitDepth: 8, colorSpace: 'cmyk' }, 'srgb')).toBe(true);
    });
  });

  // ── Combined precision + gamut degradation ──

  describe('retains when both precision and gamut degrade', () => {
    it('16-bit ProPhoto TIFF → P3 frame — both precision and gamut loss', () => {
      expect(shouldRetainSourceBlob('tiff', { bitDepth: 16, colorSpace: 'prophoto-rgb' }, 'display-p3')).toBe(true);
    });

    it('16-bit AdobeRGB PNG → P3 frame — both precision and gamut loss', () => {
      expect(shouldRetainSourceBlob('png', { bitDepth: 16, colorSpace: 'adobe-rgb' }, 'display-p3')).toBe(true);
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('colorSpace is srgb → never triggers gamut loss even with non-srgb frame', () => {
      // sRGB is a subset of P3, so no gamut loss when frame is P3
      expect(shouldRetainSourceBlob('png', { bitDepth: 8, colorSpace: 'srgb' }, 'display-p3')).toBe(false);
    });

    it('colorSpace matches frameColorSpace → no gamut loss', () => {
      expect(shouldRetainSourceBlob('jpeg', { bitDepth: 8, colorSpace: 'display-p3' }, 'display-p3')).toBe(false);
    });

    it('bitDepth exactly 8 → no precision loss', () => {
      expect(shouldRetainSourceBlob('png', { bitDepth: 8, colorSpace: 'srgb' }, 'srgb')).toBe(false);
    });

    it('undefined bitDepth treated as ≤8 (no precision loss)', () => {
      expect(shouldRetainSourceBlob('png', { colorSpace: 'srgb' }, 'srgb')).toBe(false);
    });

    it('grayscale colorSpace treated as non-srgb for gamut check', () => {
      // 'grayscale' !== 'srgb' && 'grayscale' !== 'display-p3' → would trigger retention
      // But grayscale is mapped to srgb by IMPORT_PIPELINE, so frameCS='srgb'
      // 'grayscale' !== 'srgb' → true, 'grayscale' !== 'srgb' (frameCS) → true → retains
      // This is conservative behavior — grayscale source gets retained if it's not "srgb" or frame space
      expect(shouldRetainSourceBlob('png', { bitDepth: 8, colorSpace: 'grayscale' }, 'srgb')).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HEIC: sourceBlobRetention = 'always' (revert needs original HEIC for metadata)
// ═══════════════════════════════════════════════════════════════════════════════

describe('shouldRetainSourceBlob — HEIC (always, revert needs original)', () => {
  it('always retains for HEIC with P3 colorSpace', () => {
    expect(shouldRetainSourceBlob('heic', { bitDepth: 8, colorSpace: 'display-p3' }, 'display-p3')).toBe(true);
  });

  it('always retains for HEIC with high bit depth', () => {
    expect(shouldRetainSourceBlob('heic', { bitDepth: 10, colorSpace: 'display-p3' }, 'display-p3')).toBe(true);
  });

  it('always retains for HEIC regardless of metadata', () => {
    expect(shouldRetainSourceBlob('heic', {}, 'srgb')).toBe(true);
  });
});
