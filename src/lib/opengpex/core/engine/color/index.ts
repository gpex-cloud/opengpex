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
 * engine/color — Unified color science domain.
 *
 * Gamut management, TRC, color space matrices, LUTs, HSV/hex conversions,
 * and high-precision resampling are built-in domain concerns of the engine
 * in modern graphics systems. External modules (`ColorPickerPro`,
 * `AdjustmentDrawer`, `core/files`, etc.) import via this barrel using
 * subpath aliases instead of deep paths:
 *
 *   import { gamut, ColorValue, generateCurveLUT } from '@opengpex/editor/core/engine/color';
 *
 * Dependency direction: color is a pure leaf layer at the bottom of the DAG,
 * borrowed upward only, strictly forbidden from reverse-depending on
 * gpu / sources / pipeline / facade. All exported symbols have been verified
 * conflict-free across the entire domain, so `export *` is used for full aggregation,
 * allowing the barrel surface to evolve naturally without manual synchronization.
 */

export * from './ColorValue';
export * from './srgbHsv';
export * from './gamut';
export * from './trc';
export * from './matrices';
export * from './luts';
export * from './float16';
export * from './wideGamutF16';
export * from './resampleHighDepth';
export * from './cubeLut';
