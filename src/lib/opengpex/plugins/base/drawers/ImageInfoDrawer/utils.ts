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
 * Proportional scale so the LONGER edge equals `target`. Preserves the aspect
 * ratio; both edges are rounded and clamped to a minimum of 1px (same
 * rounding discipline as `calcFinalDims`). Rounding may shift the long edge
 * by ±1px — that is acceptable; aspect distortion never is.
 */
export function fitLongEdge(w: number, h: number, target: number): { w: number; h: number } {
 const long = Math.max(w, h);
 const factor = long > 0 ? target / long : 0;
 return {
   w: Math.max(1, Math.round(w * factor)),
   h: Math.max(1, Math.round(h * factor)),
 };
}

/**
 * Proportional scale so the SHORTER edge equals `target` (e.g. an avatar
 * preset: the result fits a `target` square slot without cropping).
 * Aspect-preserving, rounded, min 1px.
 */
export function fitShortEdge(w: number, h: number, target: number): { w: number; h: number } {
 const short = Math.min(w, h);
 const factor = short > 0 ? target / short : 0;
 return {
   w: Math.max(1, Math.round(w * factor)),
   h: Math.max(1, Math.round(h * factor)),
 };
}

/**
 * Proportional scale so the image fits entirely INSIDE the `maxW` x `maxH`
 * box (contain): the limiting edge wins. Aspect-preserving, rounded, min 1px.
 * An image already smaller than the box scales UP to fill the box.
 */
export function fitWithin(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
 const factor = w > 0 && h > 0 ? Math.min(maxW / w, maxH / h) : 0;
 return {
   w: Math.max(1, Math.round(w * factor)),
   h: Math.max(1, Math.round(h * factor)),
 };
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

