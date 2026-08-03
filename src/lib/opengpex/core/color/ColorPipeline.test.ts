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
 * Unit tests for ColorPipeline strategy table and query functions.
 *
 * Validates:
 * - FORMAT_COLOR_STRATEGY completeness (all SourceFormat values covered)
 * - IMPORT_PIPELINE correctness (all ColorSpaceId values produce expected strategies)
 * - WORKING_PIPELINE correctness (all active working spaces produce expected strategies)
 * - Query functions return correct values
 * - resolveColorSpaceForFormat logic
 * - resolveDisplayColorSpace runtime resolution
 * - canUseFastExport conditions
 */

import { describe, it, expect } from 'vitest';
import type { SourceFormat } from '@opengpex/editor/core/files';
import {
  FORMAT_COLOR_STRATEGY,
  IMPORT_PIPELINE,
  WORKING_PIPELINE,
  getFormatColorStrategy,
  resolveColorSpaceForFormat,
  getImportStrategy,
  getCompositeStrategy,
  getDisplayStrategy,
  getExportStrategy,
  resolveDisplayColorSpace,
  canUseFastExport,
  shouldEmbedIcc,
  resolveExportPixelConversion,
} from './ColorPipeline';

// ═══════════════════════════════════════════════════════════════════════════════
// FORMAT_COLOR_STRATEGY completeness
// ═══════════════════════════════════════════════════════════════════════════════

describe('FORMAT_COLOR_STRATEGY', () => {
  const ALL_FORMATS = [
    'jpeg', 'png', 'bmp', 'webp', 'avif', 'heic', 'tiff', 'raw', 'svg', 'eps', 'gif', 'unknown',
  ] as const;

  it('covers all SourceFormat values', () => {
    for (const format of ALL_FORMATS) {
      expect(FORMAT_COLOR_STRATEGY[format]).toBeDefined();
    }
  });

  it('formats with readColorMetadata=false resolve to sRGB via possibleColorSpaces fallback', () => {
    for (const format of ALL_FORMATS) {
      const strategy = FORMAT_COLOR_STRATEGY[format];
      if (!strategy.readColorMetadata) {
        // possibleColorSpaces is empty → resolveColorSpaceForFormat falls back to 'srgb'
        expect(resolveColorSpaceForFormat(format as SourceFormat, undefined)).toBe('srgb');
      }
    }
  });

  it('sourceBlobRetention is valid enum for all formats', () => {
    const validValues = ['always', 'on-fidelity-loss', 'never'];
    for (const format of ALL_FORMATS) {
      expect(validValues).toContain(FORMAT_COLOR_STRATEGY[format].sourceBlobRetention);
    }
  });

  it('RAW always retains sourceBlob', () => {
    expect(FORMAT_COLOR_STRATEGY['raw'].sourceBlobRetention).toBe('always');
  });

  it('BMP/GIF/SVG/EPS never retain sourceBlob', () => {
    expect(FORMAT_COLOR_STRATEGY['bmp'].sourceBlobRetention).toBe('never');
    expect(FORMAT_COLOR_STRATEGY['gif'].sourceBlobRetention).toBe('never');
    expect(FORMAT_COLOR_STRATEGY['svg'].sourceBlobRetention).toBe('never');
    expect(FORMAT_COLOR_STRATEGY['eps'].sourceBlobRetention).toBe('never');
  });

  it('HEIC does not support ICC embed (decode-only)', () => {
    expect(FORMAT_COLOR_STRATEGY['heic'].supportsIccEmbed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getFormatColorStrategy
// ═══════════════════════════════════════════════════════════════════════════════

describe('getFormatColorStrategy', () => {
  it('returns correct strategy for known formats', () => {
    expect(getFormatColorStrategy('png').readColorMetadata).toBe(true);
    expect(getFormatColorStrategy('bmp').readColorMetadata).toBe(false);
  });

  it('falls back to "unknown" for invalid format', () => {
    // @ts-expect-error — testing defensive fallback
    const strategy = getFormatColorStrategy('invalid-format');
    expect(strategy.readColorMetadata).toBe(false);
    expect(strategy.possibleColorSpaces).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// resolveColorSpaceForFormat
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveColorSpaceForFormat', () => {
  it('returns sRGB for non-color-aware formats (ignoring detected value)', () => {
    expect(resolveColorSpaceForFormat('bmp', 'display-p3')).toBe('srgb');
    expect(resolveColorSpaceForFormat('gif', 'adobe-rgb')).toBe('srgb');
    expect(resolveColorSpaceForFormat('svg', undefined)).toBe('srgb');
  });

  it('returns detected colorSpace for color-aware formats when provided', () => {
    expect(resolveColorSpaceForFormat('png', 'display-p3')).toBe('display-p3');
    expect(resolveColorSpaceForFormat('jpeg', 'adobe-rgb')).toBe('adobe-rgb');
    expect(resolveColorSpaceForFormat('tiff', 'prophoto-rgb')).toBe('prophoto-rgb');
  });

  it('falls back to possibleColorSpaces[0] when detection returns undefined', () => {
    expect(resolveColorSpaceForFormat('png', undefined)).toBe('srgb');
    expect(resolveColorSpaceForFormat('jpeg', undefined)).toBe('srgb');
    expect(resolveColorSpaceForFormat('avif', undefined)).toBe('srgb');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT_PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

describe('IMPORT_PIPELINE', () => {
  const ALL_COLOR_SPACES = [
    'srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'cmyk', 'grayscale', 'unknown',
  ] as const;

  it('covers all ColorSpaceId values', () => {
    for (const cs of ALL_COLOR_SPACES) {
      expect(IMPORT_PIPELINE[cs]).toBeDefined();
    }
  });

  it('sRGB requires no conversion', () => {
    const strategy = IMPORT_PIPELINE['srgb'];
    expect(strategy.frameColorSpace).toBe('srgb');
    expect(strategy.conversion).toBe('none');
  });

  it('Display P3 requires no conversion', () => {
    const strategy = IMPORT_PIPELINE['display-p3'];
    expect(strategy.frameColorSpace).toBe('display-p3');
    expect(strategy.conversion).toBe('none');
  });

  it('Adobe RGB converts to P3 via matrix', () => {
    const strategy = IMPORT_PIPELINE['adobe-rgb'];
    expect(strategy.frameColorSpace).toBe('display-p3');
    expect(strategy.conversion).toBe('matrix');
  });

  it('ProPhoto RGB converts to P3 via matrix', () => {
    const strategy = IMPORT_PIPELINE['prophoto-rgb'];
    expect(strategy.frameColorSpace).toBe('display-p3');
    expect(strategy.conversion).toBe('matrix');
  });

  it('CMYK uses ICC engine to convert to sRGB', () => {
    const strategy = IMPORT_PIPELINE['cmyk'];
    expect(strategy.frameColorSpace).toBe('srgb');
    expect(strategy.conversion).toBe('icc-engine');
  });

  it('unknown uses ICC engine to convert to sRGB', () => {
    const strategy = IMPORT_PIPELINE['unknown'];
    expect(strategy.frameColorSpace).toBe('srgb');
    expect(strategy.conversion).toBe('icc-engine');
  });

  it('grayscale treated as sRGB with no conversion', () => {
    const strategy = IMPORT_PIPELINE['grayscale'];
    expect(strategy.frameColorSpace).toBe('srgb');
    expect(strategy.conversion).toBe('none');
  });

  it('all frameColorSpace values are either srgb or display-p3', () => {
    for (const cs of ALL_COLOR_SPACES) {
      const strategy = IMPORT_PIPELINE[cs];
      expect(['srgb', 'display-p3']).toContain(strategy.frameColorSpace);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getImportStrategy
// ═══════════════════════════════════════════════════════════════════════════════

describe('getImportStrategy', () => {
  it('returns correct strategy for all known color spaces', () => {
    expect(getImportStrategy('srgb').conversion).toBe('none');
    expect(getImportStrategy('display-p3').conversion).toBe('none');
    expect(getImportStrategy('adobe-rgb').conversion).toBe('matrix');
    expect(getImportStrategy('prophoto-rgb').conversion).toBe('matrix');
    expect(getImportStrategy('cmyk').conversion).toBe('icc-engine');
    expect(getImportStrategy('unknown').conversion).toBe('icc-engine');
  });

  it('falls back to unknown strategy for invalid color space', () => {
    // @ts-expect-error — testing defensive fallback
    const strategy = getImportStrategy('nonexistent');
    expect(strategy.frameColorSpace).toBe('srgb');
    expect(strategy.conversion).toBe('icc-engine');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WORKING_PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

describe('WORKING_PIPELINE', () => {
  it('covers srgb and display-p3', () => {
    expect(WORKING_PIPELINE['srgb']).toBeDefined();
    expect(WORKING_PIPELINE['display-p3']).toBeDefined();
  });

  it('srgb composite uses srgb canvas', () => {
    expect(WORKING_PIPELINE['srgb'].composite.canvasColorSpace).toBe('srgb');
    expect(WORKING_PIPELINE['srgb'].composite.needsMatrixConversion).toBe(false);
  });

  it('display-p3 composite uses display-p3 canvas', () => {
    expect(WORKING_PIPELINE['display-p3'].composite.canvasColorSpace).toBe('display-p3');
    expect(WORKING_PIPELINE['display-p3'].composite.needsMatrixConversion).toBe(false);
  });

  it('srgb display uses srgb canvas without fallback', () => {
    expect(WORKING_PIPELINE['srgb'].display.canvasColorSpace).toBe('srgb');
    expect(WORKING_PIPELINE['srgb'].display.needsFallbackConversion).toBe(false);
  });

  it('display-p3 display uses auto-p3 with fallback', () => {
    expect(WORKING_PIPELINE['display-p3'].display.canvasColorSpace).toBe('auto-p3');
    expect(WORKING_PIPELINE['display-p3'].display.needsFallbackConversion).toBe(true);
  });

  it('srgb export: embeds ICC by default (industry standard)', () => {
    expect(WORKING_PIPELINE['srgb'].export.encodeColorSpace).toBe('srgb');
    expect(WORKING_PIPELINE['srgb'].export.embedIccByDefault).toBe(true);
  });

  it('display-p3 export: embeds ICC by default', () => {
    expect(WORKING_PIPELINE['display-p3'].export.encodeColorSpace).toBe('display-p3');
    expect(WORKING_PIPELINE['display-p3'].export.embedIccByDefault).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getCompositeStrategy
// ═══════════════════════════════════════════════════════════════════════════════

describe('getCompositeStrategy', () => {
  it('srgb → srgb canvas', () => {
    const strategy = getCompositeStrategy('srgb');
    expect(strategy.canvasColorSpace).toBe('srgb');
    expect(strategy.needsMatrixConversion).toBe(false);
  });

  it('display-p3 → display-p3 canvas', () => {
    const strategy = getCompositeStrategy('display-p3');
    expect(strategy.canvasColorSpace).toBe('display-p3');
    expect(strategy.needsMatrixConversion).toBe(false);
  });

  it('unknown working space falls back to srgb', () => {
    // toActive() maps anything non-P3 to srgb
    const strategy = getCompositeStrategy('adobe-rgb');
    expect(strategy.canvasColorSpace).toBe('srgb');
  });

  it('prophoto-rgb falls back to srgb', () => {
    const strategy = getCompositeStrategy('prophoto-rgb');
    expect(strategy.canvasColorSpace).toBe('srgb');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getDisplayStrategy
// ═══════════════════════════════════════════════════════════════════════════════

describe('getDisplayStrategy', () => {
  it('srgb display: no fallback needed', () => {
    const strategy = getDisplayStrategy('srgb');
    expect(strategy.canvasColorSpace).toBe('srgb');
    expect(strategy.needsFallbackConversion).toBe(false);
  });

  it('display-p3 display: auto-p3 with fallback', () => {
    const strategy = getDisplayStrategy('display-p3');
    expect(strategy.canvasColorSpace).toBe('auto-p3');
    expect(strategy.needsFallbackConversion).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getExportStrategy
// ═══════════════════════════════════════════════════════════════════════════════

describe('getExportStrategy', () => {
  it('srgb export: srgb canvas, embeds ICC by default', () => {
    const strategy = getExportStrategy('srgb');
    expect(strategy.encodeColorSpace).toBe('srgb');
    expect(strategy.embedIccByDefault).toBe(true);
  });

  it('display-p3 export: P3 canvas, embeds ICC', () => {
    const strategy = getExportStrategy('display-p3');
    expect(strategy.encodeColorSpace).toBe('display-p3');
    expect(strategy.embedIccByDefault).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// resolveDisplayColorSpace
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveDisplayColorSpace', () => {
  it('srgb frame → srgb regardless of display capability', () => {
    expect(resolveDisplayColorSpace('srgb', true)).toBe('srgb');
    expect(resolveDisplayColorSpace('srgb', false)).toBe('srgb');
  });

  it('display-p3 frame + P3 display → display-p3', () => {
    expect(resolveDisplayColorSpace('display-p3', true)).toBe('display-p3');
  });

  it('display-p3 frame + sRGB display → srgb (fallback)', () => {
    expect(resolveDisplayColorSpace('display-p3', false)).toBe('srgb');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// canUseFastExport
// ═══════════════════════════════════════════════════════════════════════════════

describe('canUseFastExport', () => {
  const makeFrame = (overrides?: Partial<{
    layerCount: number;
    isEdited: boolean;
    sourceBlob: Blob | null;
    sourceFormat: SourceFormat;
  }>) => ({
    layerCount: 1,
    isEdited: false,
    sourceBlob: new Blob(['test']) as Blob | null,
    sourceFormat: 'png' as SourceFormat,
    ...overrides,
  });

  it('returns true when all conditions met', () => {
    expect(canUseFastExport(makeFrame(), 'png', true)).toBe(true);
  });

  it('returns false when isUnchanged is false', () => {
    expect(canUseFastExport(makeFrame(), 'png', false)).toBe(false);
  });

  it('returns false when multi-layer', () => {
    expect(canUseFastExport(makeFrame({ layerCount: 2 }), 'png', true)).toBe(false);
  });

  it('returns false when edited', () => {
    expect(canUseFastExport(makeFrame({ isEdited: true }), 'png', true)).toBe(false);
  });

  it('returns false when sourceBlob is null', () => {
    expect(canUseFastExport(makeFrame({ sourceBlob: null }), 'png', true)).toBe(false);
  });

  it('returns false when export format differs from source', () => {
    expect(canUseFastExport(makeFrame({ sourceFormat: 'png' }), 'jpeg', true)).toBe(false);
  });

  it('returns true for JPEG→JPEG fast-path', () => {
    expect(canUseFastExport(makeFrame({ sourceFormat: 'jpeg' }), 'jpeg', true)).toBe(true);
  });

  it('returns true for TIFF→TIFF fast-path', () => {
    expect(canUseFastExport(makeFrame({ sourceFormat: 'tiff' }), 'tiff', true)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// shouldEmbedIcc
// ═══════════════════════════════════════════════════════════════════════════════

describe('shouldEmbedIcc', () => {
  it('embeds for sRGB frame when format supports ICC (industry standard)', () => {
    expect(shouldEmbedIcc('png', 'srgb')).toBe(true);
    expect(shouldEmbedIcc('jpeg', 'srgb')).toBe(true);
    expect(shouldEmbedIcc('tiff', 'srgb')).toBe(true);
  });

  it('embeds for display-p3 frame when format supports ICC', () => {
    expect(shouldEmbedIcc('png', 'display-p3')).toBe(true);
    expect(shouldEmbedIcc('jpeg', 'display-p3')).toBe(true);
  });

  it('does not embed for formats that do not support ICC', () => {
    expect(shouldEmbedIcc('bmp', 'srgb')).toBe(false);
    expect(shouldEmbedIcc('gif', 'display-p3')).toBe(false);
    expect(shouldEmbedIcc('heic', 'srgb')).toBe(false);
  });

  it('respects user override = false', () => {
    expect(shouldEmbedIcc('png', 'srgb', false)).toBe(false);
  });

  it('user override cannot bypass format limitation', () => {
    // Format hard gate: supportsIccEmbed=false blocks even explicit user override
    expect(shouldEmbedIcc('bmp', 'srgb', true)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// resolveExportPixelConversion
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveExportPixelConversion', () => {
  it('returns "none" when embedIcc is false', () => {
    const result = resolveExportPixelConversion(
      'srgb',
      { colorSpace: 'adobe-rgb', hasIccProfileData: true },
      false,
    );
    expect(result).toBe('none');
  });

  it('returns "none" when frame is not sRGB (pixels already in correct space)', () => {
    const result = resolveExportPixelConversion(
      'display-p3',
      { colorSpace: 'display-p3', hasIccProfileData: true },
      true,
    );
    expect(result).toBe('none');
  });

  it('returns "none" when source has no ICC profile data', () => {
    const result = resolveExportPixelConversion(
      'srgb',
      { colorSpace: 'adobe-rgb', hasIccProfileData: false },
      true,
    );
    expect(result).toBe('none');
  });

  it('returns "none" when source colorSpace is sRGB (no conversion needed)', () => {
    const result = resolveExportPixelConversion(
      'srgb',
      { colorSpace: 'srgb', hasIccProfileData: true },
      true,
    );
    expect(result).toBe('none');
  });

  it('returns "srgb-to-icc" when all conditions met (sRGB frame + non-sRGB source + ICC data + embedIcc)', () => {
    const result = resolveExportPixelConversion(
      'srgb',
      { colorSpace: 'adobe-rgb', hasIccProfileData: true },
      true,
    );
    expect(result).toBe('srgb-to-icc');
  });

  it('returns "srgb-to-icc" for ProPhoto source with ICC data in sRGB frame', () => {
    const result = resolveExportPixelConversion(
      'srgb',
      { colorSpace: 'prophoto-rgb', hasIccProfileData: true },
      true,
    );
    expect(result).toBe('srgb-to-icc');
  });

  // ─── Format-based fallback (p3-to-srgb) ───

  it('returns "p3-to-srgb" when P3 frame targets BMP (format without P3 support)', () => {
    const result = resolveExportPixelConversion(
      'display-p3',
      { colorSpace: 'display-p3', hasIccProfileData: false },
      false,
      'bmp',
    );
    expect(result).toBe('p3-to-srgb');
  });

  it('returns "p3-to-srgb" when P3 frame targets GIF (format without P3 support)', () => {
    const result = resolveExportPixelConversion(
      'display-p3',
      { colorSpace: 'display-p3', hasIccProfileData: false },
      false,
      'gif',
    );
    expect(result).toBe('p3-to-srgb');
  });

  it('returns "none" when P3 frame targets PNG (format supports P3)', () => {
    const result = resolveExportPixelConversion(
      'display-p3',
      { colorSpace: 'display-p3', hasIccProfileData: false },
      false,
      'png',
    );
    expect(result).toBe('none');
  });

  it('returns "none" when sRGB frame targets BMP (no P3 fallback needed for sRGB)', () => {
    const result = resolveExportPixelConversion(
      'srgb',
      { colorSpace: 'srgb', hasIccProfileData: false },
      false,
      'bmp',
    );
    expect(result).toBe('none');
  });

  it('backward compatible: no targetFormat → same behavior as before', () => {
    const result = resolveExportPixelConversion(
      'display-p3',
      { colorSpace: 'display-p3', hasIccProfileData: false },
      false,
    );
    expect(result).toBe('none');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getExportStrategy — format-based fallback
// ═══════════════════════════════════════════════════════════════════════════════

describe('getExportStrategy with targetFormat', () => {
  it('P3 frame + BMP → fallback to sRGB (BMP has empty possibleColorSpaces)', () => {
    const strategy = getExportStrategy('display-p3', 'bmp');
    expect(strategy.encodeColorSpace).toBe('srgb');
    expect(strategy.embedIccByDefault).toBe(false);
  });

  it('P3 frame + GIF → fallback to sRGB (GIF has empty possibleColorSpaces)', () => {
    const strategy = getExportStrategy('display-p3', 'gif');
    expect(strategy.encodeColorSpace).toBe('srgb');
    expect(strategy.embedIccByDefault).toBe(false);
  });

  it('P3 frame + PNG → no fallback (PNG supports P3)', () => {
    const strategy = getExportStrategy('display-p3', 'png');
    expect(strategy.encodeColorSpace).toBe('display-p3');
    expect(strategy.embedIccByDefault).toBe(true);
  });

  it('P3 frame + JPEG → no fallback (JPEG supports P3)', () => {
    const strategy = getExportStrategy('display-p3', 'jpeg');
    expect(strategy.encodeColorSpace).toBe('display-p3');
    expect(strategy.embedIccByDefault).toBe(true);
  });

  it('sRGB frame + BMP → no fallback needed (sRGB is always fine)', () => {
    const strategy = getExportStrategy('srgb', 'bmp');
    expect(strategy.encodeColorSpace).toBe('srgb');
    expect(strategy.embedIccByDefault).toBe(false);  // BMP doesn't support ICC embed
  });

  it('backward compatible: no targetFormat → same as WORKING_PIPELINE lookup', () => {
    const strategy = getExportStrategy('display-p3');
    expect(strategy.encodeColorSpace).toBe('display-p3');
    expect(strategy.embedIccByDefault).toBe(true);
  });
});
