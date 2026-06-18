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

'use client';

import * as P from './protocols';

/**
 * Calculates the final physical dimensions for export or canvas resizing
 * based on the absolute pixels in config.
 */
export function calcFinalDims(baseW: number, baseH: number, config: P.ExportConfig) {
 const w = config.pixels?.w || baseW;
 const h = config.pixels?.h || baseH;
 
 return { w: Math.round(w), h: Math.round(h) };
}

/**
 * Derives the current width, height, and scale percentage based on the config.
 */
export function deriveResizeState(baseW: number, baseH: number, pixels?: { w: number, h: number }) {
 const currentW = pixels?.w || baseW;
 const currentH = pixels?.h || baseH;
 const currentPercent = baseW ? Math.round((currentW / baseW) * 100) : 100;
 return { currentW, currentH, currentPercent };
}

/**
 * Calculates the next pixels when width is manually changed.
 */
export function calculateNextPixelsByWidth(newW: number, baseW: number, baseH: number, currentH: number, lockAspect: boolean) {
 const nextW = newW || 0;
 const nextH = lockAspect && baseW > 0 ? Math.round(nextW / (baseW / baseH)) : currentH;
 return { w: nextW, h: nextH };
}

/**
 * Calculates the next pixels when height is manually changed.
 */
export function calculateNextPixelsByHeight(newH: number, baseW: number, baseH: number, currentW: number, lockAspect: boolean) {
 const nextH = newH || 0;
 const nextW = lockAspect && baseH > 0 ? Math.round(nextH * (baseW / baseH)) : currentW;
 return { w: nextW, h: nextH };
}

/**
 * Calculates the next pixels when percentage slider is dragged, with snapping.
 */
export function calculateNextPixelsByPercent(val: number, baseW: number, baseH: number) {
 let finalPercent = val;
 const snapPoints = [25, 50, 100, 200, 400];
 const threshold = 4;
 for (const p of snapPoints) {
 if (Math.abs(val - p) <= threshold) {
 finalPercent = p;
 break;
 }
 }
 const nextW = Math.max(1, Math.round(baseW * (finalPercent / 100)));
 const nextH = Math.max(1, Math.round(baseH * (finalPercent / 100)));
 return { w: nextW, h: nextH, percent: finalPercent };
}

