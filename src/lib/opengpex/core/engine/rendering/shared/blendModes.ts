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
 * blendModes.ts — Blend mode classification and utilities.
 *
 * Key convention: Uses Canvas 2D globalCompositeOperation values (e.g. 'source-over',
 * not 'normal') as this is the canonical format stored in Layer.blendMode.
 *
 * This module provides backend-agnostic blend mode utilities.
 * Backend-specific mappings (e.g., vips enum values) live in their respective backends.
 *
 * @module core/engine/rendering/shared/blendModes
 */

// ─── Non-separable HSL modes (require manual pixel-level implementation) ───

/**
 * Set of blend modes that cannot be natively composited by simple per-channel math.
 * These require manual per-pixel HSL decomposition via blend2d.ts.
 *
 * Backends that don't support these natively (e.g., vips) must use the blend2d.ts
 * fallback path for correct rendering.
 */
export const NON_SEPARABLE_BLEND_MODES: ReadonlySet<string> = new Set([
  'hue', 'saturation', 'color', 'luminosity',
]);

/**
 * Check if a blend mode requires manual pixel-level implementation.
 * These modes cannot be handled by simple per-channel composite and need blend2d.ts.
 */
export function isNonSeparableBlendMode(mode: string | undefined): boolean {
  return !!mode && NON_SEPARABLE_BLEND_MODES.has(mode);
}
