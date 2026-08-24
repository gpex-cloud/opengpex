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
 * ColorPipeline — Centralized Color Pipeline Strategy Router.
 *
 * All color-space-related pipeline decisions are defined in this module.
 * Consumers (handlers, dispatcher, renderer) query strategy functions
 * instead of doing their own if/else branching.
 *
 * Modifying the behavior of a color space only requires changing this file
 * — single source of truth.
 *
 * Architecture:
 *   Two-layer strategy matrix:
 *   1. FORMAT_COLOR_STRATEGY — per SourceFormat, decides "does this format read color metadata?"
 *   2. IMPORT_PIPELINE + WORKING_PIPELINE — per ColorSpaceId / WorkingColorSpace,
 *      decides "how does this space behave at each pipeline stage?"
 *
 *   Flow: File → Format Strategy (resolve colorSpace) → ColorSpace Strategy (pipeline behavior)
 *
 * @module core/color/ColorPipeline
 */

import type { SourceFormat, ColorSpaceId } from '@opengpex/editor/core/files';
import type { WorkingColorSpace } from '@opengpex/editor/core/types';

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 1: Format Color Strategy
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format-level color strategy — determines how each file format detects/handles color spaces.
 *
 * All supported formats MUST appear in the strategy table.
 * No format is allowed to operate outside this strategy.
 */
export interface FormatColorStrategy {
  /**
   * Whether to read color metadata (ICC Profile / EXIF / chunk) from this format.
   *
   * - true: handler.extractMetadata() parses ICC and identifies a ColorSpaceId
   * - false: skip color metadata parsing, use possibleColorSpaces[0] directly
   */
  readColorMetadata: boolean;

  /**
   * Whether this format supports embedding ICC Profiles (for export).
   */
  supportsIccEmbed: boolean;

  /**
   * Possible color spaces for this format (for UI hints / validation).
   * Empty array means the format cannot carry non-sRGB color spaces.
   */
  possibleColorSpaces: ColorSpaceId[];

  /**
   * Source blob retention policy — decides when to preserve original file bytes for export recovery.
   *
   * Background: The pipeline works in 8-bit + P3/sRGB space. When source file precision
   * or gamut exceeds pipeline capability, the in-pipeline pixels are a lossy downgraded
   * representation. Retaining sourceBlob enables restoring original lossless data on export
   * (when format matches + unedited).
   *
   * 'always'           — Always retain (RAW: pipeline can never fully represent original data)
   * 'on-fidelity-loss' — Retain when precision or gamut degradation is detected
   *                      Condition: bitDepth > 8 || colorSpace ∉ {srgb, frame.colorSpace}
   * 'never'            — Never retain (pipeline representation ≥ source file precision)
   */
  sourceBlobRetention: 'always' | 'on-fidelity-loss' | 'never';
}

export const FORMAT_COLOR_STRATEGY: Record<SourceFormat, FormatColorStrategy> = {

  // ─── Raster formats supporting ICC embed ───

  'png': {
    readColorMetadata: true,
    supportsIccEmbed: true,
    possibleColorSpaces: ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'grayscale'],
    sourceBlobRetention: 'on-fidelity-loss',  // 16-bit PNG or non-sRGB PNG → retain
  },

  'jpeg': {
    readColorMetadata: true,
    supportsIccEmbed: true,
    possibleColorSpaces: ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'cmyk'],
    sourceBlobRetention: 'on-fidelity-loss',  // AdobeRGB JPEG → retain (import converts to P3 with loss)
  },

  'webp': {
    readColorMetadata: true,
    supportsIccEmbed: true,
    possibleColorSpaces: ['srgb', 'display-p3', 'adobe-rgb'],
    sourceBlobRetention: 'on-fidelity-loss',  // AdobeRGB WebP → retain
  },

  'avif': {
    readColorMetadata: true,
    supportsIccEmbed: true,
    possibleColorSpaces: ['srgb', 'display-p3', 'adobe-rgb'],
    sourceBlobRetention: 'on-fidelity-loss',  // AdobeRGB AVIF → retain
  },

  'heic': {
    readColorMetadata: true,
    supportsIccEmbed: false,  // HEIC is decode-only, no export path
    possibleColorSpaces: ['srgb', 'display-p3'],
    sourceBlobRetention: 'always',  // No export path, but revert needs original HEIC for metadata re-extraction
  },

  'tiff': {
    readColorMetadata: true,
    supportsIccEmbed: true,
    possibleColorSpaces: ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'cmyk', 'grayscale'],
    sourceBlobRetention: 'on-fidelity-loss',  // 16-bit or ProPhoto TIFF → retain
  },

  'raw': {
    readColorMetadata: true,
    supportsIccEmbed: false,
    possibleColorSpaces: ['srgb', 'display-p3', 'prophoto-rgb'],
    sourceBlobRetention: 'always',  // RAW always retained (pipeline cannot fully represent 14-bit ProPhoto)
  },

  // ─── Formats without color space support (fixed sRGB) ───

  'bmp': {
    readColorMetadata: false,
    supportsIccEmbed: false,
    possibleColorSpaces: [],
    sourceBlobRetention: 'never',  // 8-bit sRGB, pipeline represents losslessly
  },

  'gif': {
    readColorMetadata: false,
    supportsIccEmbed: false,
    possibleColorSpaces: [],
    sourceBlobRetention: 'never',  // Indexed color → 8-bit sRGB, no information loss
  },

  'svg': {
    readColorMetadata: false,
    supportsIccEmbed: false,
    possibleColorSpaces: [],
    sourceBlobRetention: 'never',  // Rasterized to fixed sRGB 8-bit
  },

  'eps': {
    readColorMetadata: false,
    supportsIccEmbed: false,
    possibleColorSpaces: [],
    sourceBlobRetention: 'never',  // Same as SVG
  },

  'unknown': {
    readColorMetadata: false,
    supportsIccEmbed: false,
    possibleColorSpaces: [],
    sourceBlobRetention: 'never',
  },
};

// ─── Format Strategy Query Functions ───

/**
 * Look up color capabilities for a file format.
 *
 * Problem solved: different formats have vastly different color handling capabilities
 * (PNG can embed ICC, BMP cannot; TIFF supports 16-bit, GIF doesn't).
 * Callers query this table instead of hardcoding format-specific if/else branches.
 *
 * @example
 * // Export panel deciding whether to show "Embed ICC Profile" toggle:
 * const strategy = getFormatColorStrategy('png');
 * if (strategy.supportsIccEmbed) showIccToggle();  // PNG → show
 *
 * const strategy2 = getFormatColorStrategy('bmp');
 * if (strategy2.supportsIccEmbed) showIccToggle();  // BMP → hidden (false)
 */
export function getFormatColorStrategy(format: SourceFormat): FormatColorStrategy {
  return FORMAT_COLOR_STRATEGY[format] ?? FORMAT_COLOR_STRATEGY['unknown'];
}

/**
 * Determine the final ColorSpaceId for a file, merging detected metadata with format defaults.
 *
 * Problem solved: decoders attempt to parse ICC profiles from files to identify color space,
 * but this may fail (file has no ICC data, or the format itself doesn't support color metadata).
 * This function provides a unified "use detection if available, otherwise fall back to a safe
 * format-level default" merge logic, so handlers don't need their own fallback branches.
 *
 * @example
 * // Opening a PNG with Display P3 ICC profile — detection succeeded:
 * resolveColorSpaceForFormat('png', 'display-p3')
 * // → 'display-p3' (detected value used directly)
 *
 * @example
 * // Opening a PNG without any ICC data — detection returned undefined:
 * resolveColorSpaceForFormat('png', undefined)
 * // → 'srgb' (format supports metadata but nothing found; fallback to possibleColorSpaces[0])
 *
 * @example
 * // Opening a BMP — format doesn't read color metadata at all (readColorMetadata=false):
 * resolveColorSpaceForFormat('bmp', undefined)
 * // → 'srgb' (skips detection entirely, returns format's hard-coded default)
 *
 * @param format - The file's SourceFormat
 * @param detectedCS - The colorSpace detected by handler.extractMetadata() (may be undefined if parsing failed or was skipped)
 * @returns The final determined ColorSpaceId to use for the frame
 */
export function resolveColorSpaceForFormat(
  format: SourceFormat,
  detectedCS: ColorSpaceId | undefined,
): ColorSpaceId {
  const strategy = getFormatColorStrategy(format);
  if (!strategy.readColorMetadata) {
    // This format doesn't read color metadata — use first possible space or sRGB
    return strategy.possibleColorSpaces[0] ?? 'srgb';
  }
  // Read metadata but got no valid value → fallback to first possible space or sRGB
  return detectedCS ?? (strategy.possibleColorSpaces[0] ?? 'srgb');
}

/**
 * Determine whether to retain sourceBlob.
 * Called at end of handler.decode(), replaces manual per-handler checks.
 *
 * @example
 * // In tiff/decode.ts — 16-bit TIFF retains source for lossless export:
 * shouldRetainSourceBlob('tiff', { bitDepth: 16, colorSpace: 'srgb' }, 'srgb')
 * // → true (on-fidelity-loss: bitDepth > 8)
 *
 * @example
 * // In png/decode.ts — 8-bit sRGB PNG has no fidelity loss:
 * shouldRetainSourceBlob('png', { bitDepth: 8, colorSpace: 'srgb' }, 'srgb')
 * // → false (on-fidelity-loss: neither condition met)
 *
 * @example
 * // RAW files always retain:
 * shouldRetainSourceBlob('raw', { bitDepth: 14 }, 'display-p3')
 * // → true (strategy is 'always')
 *
 * @param format         - The file's SourceFormat
 * @param metadata       - Parsed metadata (bitDepth, colorSpace)
 * @param frameColorSpace - The actual Frame.colorSpace after import (determined by IMPORT_PIPELINE)
 * @returns Whether to retain sourceBlob
 */
export function shouldRetainSourceBlob(
  format: SourceFormat,
  metadata: { bitDepth?: number; colorSpace?: ColorSpaceId },
  frameColorSpace: WorkingColorSpace,
): boolean {
  const strategy = getFormatColorStrategy(format);
  switch (strategy.sourceBlobRetention) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'on-fidelity-loss':
      // Precision degradation: source precision exceeds pipeline 8-bit capability
      if (metadata.bitDepth && metadata.bitDepth > 8) return true;
      // Gamut degradation: source color space exceeds pipeline working space capability
      // i.e.: source colorSpace exists, ≠ sRGB, ≠ imported frameColorSpace
      // (e.g. AdobeRGB source → frameColorSpace='display-p3', gamut has ~2% loss)
      if (metadata.colorSpace &&
          metadata.colorSpace !== 'srgb' &&
          metadata.colorSpace !== frameColorSpace) {
        return true;
      }
      return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 2: Color Space Pipeline Strategy
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Strategy Type Definitions ───

export interface ImportStrategy {
  /** What Frame.colorSpace should be set to after import */
  frameColorSpace: WorkingColorSpace;

  /**
   * Conversion instruction — handler executes without any decision-making.
   *
   * 'none'       — Zero conversion, use browser-decoded pixels directly (source space === frameColorSpace)
   * 'matrix'     — Use convertImageDataColorSpace(pixels, matrixFrom, frameColorSpace)
   *                for 3×3 matrix conversion (lightweight, main thread, ~4ms/1080p)
   * 'icc-engine' — Delegate to vips iccToSrgb() (or future iccToP3) for full ICC engine conversion
   *                Used for scenarios that cannot be handled by 3×3 matrices (CMYK, custom ICC Profiles)
   */
  conversion: 'none' | 'matrix' | 'icc-engine';
}

export interface CompositeStrategy {
  /**
   * Canvas 2D context's colorSpace parameter.
   * Browsers only support 'srgb' | 'display-p3'.
   */
  canvasColorSpace: PredefinedColorSpace;

  /**
   * Whether per-layer pixel color space matrix conversion is needed before compositing.
   *
   * When Frame.colorSpace (e.g. adobe-rgb) cannot map directly to a Canvas 2D
   * supported colorSpace, pixels must be converted from source space to the
   * canvasColorSpace's corresponding space before drawImage.
   */
  needsMatrixConversion: boolean;

  /** Matrix conversion source→target pair (only valid when needsMatrixConversion=true) */
  matrixPair?: { from: WorkingColorSpace; to: WorkingColorSpace };
}

/**
 * Display strategy canvasColorSpace type.
 * Defined independently (not directly using PredefinedColorSpace | string)
 * to ensure type safety and avoid conflicts with Web API's PredefinedColorSpace.
 */
type DisplayCanvasColorSpace = 'srgb' | 'display-p3' | 'auto-p3';

export interface DisplayStrategy {
  /**
   * Screen preview canvas colorSpace.
   * Hardware-limited: on non-P3 displays, setting 'display-p3' has no visual benefit
   * but data precision is preserved.
   *
   * 'auto-p3' — Determined at runtime by `displaySupportsP3()` hardware detection:
   *   P3 display → 'display-p3'
   *   sRGB display → 'srgb' + CPU-side matrix conversion
   */
  canvasColorSpace: DisplayCanvasColorSpace;

  /**
   * Whether fallback matrix conversion is needed when the display doesn't support
   * the target gamut.
   * (e.g. P3 frame on sRGB display needs P3→sRGB matrix clamp)
   */
  needsFallbackConversion: boolean;
}

export interface ExportStrategy {
  /**
   * Canvas colorSpace used for intermediate encode() canvas.
   * Prevents implicit browser color space conversion when going ImageBitmap → canvas.
   */
  encodeColorSpace: PredefinedColorSpace;

  /** Whether to embed ICC Profile by default (when source metadata has ICC data) */
  embedIccByDefault: boolean;

  // pixelConversion removed → now determined at runtime by resolveExportPixelConversion()
}

// ─── Strategy Matrix: Two Tables ───

/**
 * Table 1: IMPORT_PIPELINE
 *
 * Indexed by source file's detected ColorSpaceId.
 * Responsibility: decides "what should Frame.colorSpace be after import?"
 * Used only once during handler.decode() phase.
 */
export const IMPORT_PIPELINE: Record<ColorSpaceId, ImportStrategy> = {
  'srgb':         { frameColorSpace: 'srgb',       conversion: 'none' },
  'display-p3':   { frameColorSpace: 'display-p3', conversion: 'none' },
  'adobe-rgb':    { frameColorSpace: 'display-p3', conversion: 'matrix' },
  // Choice A: Import-time AdobeRGB→P3 matrix conversion (P3 ⊃ AdobeRGB ~98%, nearly lossless)
  'prophoto-rgb': { frameColorSpace: 'display-p3', conversion: 'matrix' },
  // Choice A: Import-time ProPhoto→P3 matrix conversion (out-of-gamut ~30% clamped to P3)
  // Future WebGPU: change to frameColorSpace: 'prophoto-rgb', conversion: 'none' for full-range mode
  'cmyk':         { frameColorSpace: 'srgb',       conversion: 'icc-engine' },
  'grayscale':    { frameColorSpace: 'srgb',       conversion: 'none' },
  'unknown':      { frameColorSpace: 'srgb',       conversion: 'icc-engine' },
};

/**
 * Table 2: WORKING_PIPELINE
 *
 * Indexed by Frame.colorSpace (i.e. WorkingColorSpace).
 * Responsibility: decides "how to handle this Frame during composite, display, and export."
 * Used during composite/display/export phases.
 *
 * Note: Frame.colorSpace runtime values are only the subset produced by IMPORT_PIPELINE
 * (currently 'srgb' | 'display-p3'), since all non-standard spaces are converted at import.
 * Future WebGPU extension may add 'prophoto-rgb'.
 */
export interface WorkingPipelineEntry {
  composite: CompositeStrategy;
  display: DisplayStrategy;
  export: ExportStrategy;
}

/**
 * Implementation type note:
 *
 * IMPORT_PIPELINE normalizes all spaces to 'srgb' | 'display-p3',
 * so Frame.colorSpace runtime values are only these two.
 * Using precise type ActiveWorkingColorSpace ensures compile-time completeness checks.
 *
 * When WebGPU supports ProPhoto, just extend this type + add entry.
 */
type ActiveWorkingColorSpace = 'srgb' | 'display-p3';

export const WORKING_PIPELINE: Record<ActiveWorkingColorSpace, WorkingPipelineEntry> = {
  'srgb': {
    composite: { canvasColorSpace: 'srgb', needsMatrixConversion: false },
    display:   { canvasColorSpace: 'srgb', needsFallbackConversion: false },
    export:    { encodeColorSpace: 'srgb', embedIccByDefault: true },
  }, 
  'display-p3': {
    composite: { canvasColorSpace: 'display-p3', needsMatrixConversion: false },
    display:   { canvasColorSpace: 'auto-p3', needsFallbackConversion: true },
    export:    { encodeColorSpace: 'display-p3', embedIccByDefault: true },
  },
  // Future WebGPU extension (requires extending ActiveWorkingColorSpace first):
  // 'prophoto-rgb': {
  //   composite: { canvasColorSpace: 'webgpu-f16', needsMatrixConversion: false },
  //   display:   { canvasColorSpace: 'auto-p3', needsFallbackConversion: true },
  //   export:    { encodeColorSpace: 'display-p3', embedIccByDefault: true },
  // },
};

// ─── Query Functions ───

/**
 * Query the import pipeline strategy for a detected color space.
 *
 * @example
 * // In jpeg/decode.ts — AdobeRGB JPEG detected via ICC:
 * const strategy = getImportStrategy('adobe-rgb');
 * // → { frameColorSpace: 'display-p3', conversion: 'matrix' }
 * // Handler applies: AdobeRGB→P3 matrix conversion, sets frame.colorSpace='display-p3'
 *
 * @example
 * // CMYK source — needs full ICC engine conversion:
 * const strategy = getImportStrategy('cmyk');
 * // → { frameColorSpace: 'srgb', conversion: 'icc-engine' }
 * // Handler calls: vips iccToSrgb(), sets frame.colorSpace='srgb'
 */
export function getImportStrategy(cs: ColorSpaceId): ImportStrategy {
  return IMPORT_PIPELINE[cs] ?? IMPORT_PIPELINE['unknown'];
}

/**
 * Narrow WorkingColorSpace to ActiveWorkingColorSpace.
 * Since IMPORT_PIPELINE guarantees frameColorSpace only produces 'srgb' | 'display-p3',
 * other values won't occur at runtime. This function provides compile-time type bridging + defensive fallback.
 */
function toActive(frameCS: WorkingColorSpace): ActiveWorkingColorSpace {
  return (frameCS === 'display-p3') ? 'display-p3' : 'srgb';
}

/**
 * Query composite strategy for a frame's working color space.
 *
 * @example
 * // In CompositeDispatcher.ts — creating composite canvas:
 * const strategy = getCompositeStrategy('display-p3');
 * // → { canvasColorSpace: 'display-p3', needsMatrixConversion: false }
 * // Dispatcher creates: new OffscreenCanvas() with colorSpace='display-p3'
 */
export function getCompositeStrategy(frameCS: WorkingColorSpace): CompositeStrategy {
  return WORKING_PIPELINE[toActive(frameCS)].composite;
}

export function getDisplayStrategy(frameCS: WorkingColorSpace): DisplayStrategy {
  return WORKING_PIPELINE[toActive(frameCS)].display;
}

/**
 * Query export encoding strategy. Handles format-based color space fallback.
 *
 * @example
 * // P3 frame → export as PNG (format supports P3):
 * getExportStrategy('display-p3', 'png')
 * // → { encodeColorSpace: 'display-p3', embedIccByDefault: true }
 *
 * @example
 * // P3 frame → export as BMP (format doesn't support P3, auto-fallback):
 * getExportStrategy('display-p3', 'bmp')
 * // → { encodeColorSpace: 'srgb', embedIccByDefault: false }
 * // Triggers 'p3-to-srgb' pixel conversion in resolveExportPixelConversion()
 */
export function getExportStrategy(
  frameCS: WorkingColorSpace,
  targetFormat?: SourceFormat,
): ExportStrategy {
  const baseStrategy = WORKING_PIPELINE[toActive(frameCS)].export;

  if (!targetFormat) return baseStrategy;

  const formatStrategy = FORMAT_COLOR_STRATEGY[targetFormat];
  if (!formatStrategy) return baseStrategy;

  const possible = formatStrategy.possibleColorSpaces;

  // Format supports current frame color space → no fallback needed
  if (possible.includes(frameCS as ColorSpaceId)) {
    return baseStrategy;
  }

  // Format doesn't support → fallback to format's best matching space
  const fallbackCS = possible[0] ?? 'srgb';
  const fallbackEncodeCS: PredefinedColorSpace =
    fallbackCS === 'display-p3' ? 'display-p3' : 'srgb';

  return {
    encodeColorSpace: fallbackEncodeCS,
    embedIccByDefault: fallbackCS !== 'srgb' && formatStrategy.supportsIccEmbed,
  };
}

/**
 * Resolve 'auto-p3' in display strategy to a concrete PredefinedColorSpace.
 * Called at runtime (depends on displaySupportsP3() hardware detection).
 *
 * @example
 * // In CanvasStage.tsx — P3 frame on a P3-capable display:
 * resolveDisplayColorSpace('display-p3', true)
 * // → 'display-p3' (auto-p3 resolves to display-p3)
 *
 * @example
 * // P3 frame on a sRGB-only display:
 * resolveDisplayColorSpace('display-p3', false)
 * // → 'srgb' (auto-p3 falls back; needs CPU P3→sRGB matrix clamp)
 */
export function resolveDisplayColorSpace(
  frameCS: WorkingColorSpace,
  supportsP3: boolean,
): PredefinedColorSpace {
  const strategy = getDisplayStrategy(frameCS);
  if (strategy.canvasColorSpace === 'auto-p3') {
    return supportsP3 ? 'display-p3' : 'srgb';
  }
  return strategy.canvasColorSpace as PredefinedColorSpace;
}


// ═══════════════════════════════════════════════════════════════════════════════
// ICC Embed Decision
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine whether ICC Profile should be embedded in the exported file.
 *
 * Three-layer decision:
 *   1. Format capability (supportsIccEmbed) — hard constraint
 *   2. Strategy default (embedIccByDefault) — based on working color space
 *   3. User override — takes precedence when provided
 *
 * @example
 * // P3 frame → PNG (supports ICC, strategy default=true, no user override):
 * shouldEmbedIcc('png', 'display-p3', undefined)
 * // → true (Layer 2: embedIccByDefault=true)
 *
 * @example
 * // sRGB frame → BMP (format doesn't support ICC):
 * shouldEmbedIcc('bmp', 'srgb', true)
 * // → false (Layer 1: hard constraint, BMP cannot embed ICC)
 *
 * @example
 * // User explicitly disables ICC embed:
 * shouldEmbedIcc('png', 'display-p3', false)
 * // → false (Layer 3: user override takes precedence)
 *
 * @param exportFormat    - Target export format
 * @param frameColorSpace - Frame's working color space
 * @param userOverride    - User's explicit choice (undefined = use default)
 * @returns Whether to embed ICC Profile
 */
export function shouldEmbedIcc(
  exportFormat: SourceFormat,
  frameColorSpace: WorkingColorSpace,
  userOverride?: boolean,
): boolean {
  const formatStrategy = getFormatColorStrategy(exportFormat);

  // Hard constraint: format doesn't support ICC embedding
  if (!formatStrategy.supportsIccEmbed) {
    return false;
  }

  // User explicit override takes precedence
  if (userOverride !== undefined) {
    return userOverride;
  }

  // Strategy default
  const exportStrategy = getExportStrategy(frameColorSpace);
  return exportStrategy.embedIccByDefault;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Export Pixel Conversion Decision
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Export pixel conversion type.
 *
 * 'none'        — No pixel conversion needed
 * 'srgb-to-icc' — Convert sRGB pixels back to original ICC space for embedding
 * 'p3-to-srgb'  — Format fallback: convert P3 pixels to sRGB (format doesn't support P3)
 */
export type ExportPixelConversion = 'none' | 'srgb-to-icc' | 'p3-to-srgb';

/**
 * Determine if export needs pixel color space conversion.
 *
 * This is a runtime decision that depends on source metadata + export config.
 * Cannot be a static strategy table value because it depends on:
 *   - frameCS (working color space)
 *   - Whether embedding ICC is requested
 *   - Whether source has non-sRGB custom ICC profile data
 *   - Whether the target format supports the frame's color space
 *
 * @example
 * // P3 frame → export as BMP (BMP doesn't support P3):
 * resolveExportPixelConversion('display-p3', { hasIccProfileData: false }, false, 'bmp')
 * // → 'p3-to-srgb' (format fallback: must clamp P3→sRGB before encoding)
 *
 * @example
 * // sRGB frame with custom ICC profile (e.g. Japan Color 2001) → export with ICC embed:
 * resolveExportPixelConversion('srgb', { colorSpace: 'unknown', hasIccProfileData: true }, true)
 * // → 'srgb-to-icc' (restore original ICC encoding via vips srgbToIcc before embed)
 *
 * @example
 * // Normal case: P3 frame → export as PNG (PNG supports P3):
 * resolveExportPixelConversion('display-p3', { hasIccProfileData: true }, true, 'png')
 * // → 'none' (no conversion needed, P3 pixels written directly)
 *
 * @param frameCS       - Frame's working color space
 * @param sourceMeta    - Source file metadata (colorSpace + ICC profile availability)
 * @param embedIcc      - Whether ICC embedding is requested for this export
 * @param targetFormat  - Target export format (optional, for format-based fallback)
 * @returns ExportPixelConversion
 */
export function resolveExportPixelConversion(
  frameCS: WorkingColorSpace,
  sourceMeta: { colorSpace?: ColorSpaceId; hasIccProfileData: boolean },
  embedIcc: boolean,
  targetFormat?: SourceFormat,
): ExportPixelConversion {
  // Format fallback: P3→sRGB when target format doesn't support P3
  if (targetFormat) {
    const formatStrategy = FORMAT_COLOR_STRATEGY[targetFormat];
    if (formatStrategy) {
      const possible = formatStrategy.possibleColorSpaces;
      if (frameCS === 'display-p3' && !possible.includes('display-p3')) {
        return 'p3-to-srgb';
      }
    }
  }

  // srgb-to-icc: frame was downgraded to sRGB from custom ICC during import,
  // and now we want to restore the original ICC space for export.
  if (
    frameCS === 'srgb' &&
    embedIcc &&
    sourceMeta.hasIccProfileData &&
    sourceMeta.colorSpace !== undefined &&
    sourceMeta.colorSpace !== 'srgb'
  ) {
    return 'srgb-to-icc';
  }
  return 'none';
}
