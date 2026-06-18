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

// src/lib/image-editor/utils/heic.ts
/**
 * HEIC image processing logic
 */

// Define heic-to function type
type HeicToFunction = (options: { blob: Blob; type: string; quality?: number }) => Promise<Blob>;

// Extend Window interface
declare global {
    interface Window {
        heicTo?: HeicToFunction;
        HeicTo?: HeicToFunction;
    }
}

/**
 * Check if the file is in HEIC format
 */
export function isHeicFile(file: File): boolean {
    return file.type === 'image/heic' ||
        file.type === 'image/heif' ||
        file.name.toLowerCase().endsWith('.heic') ||
        file.name.toLowerCase().endsWith('.heif');
}

/**
 * Dynamically load script
 */
function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = (e) => reject(e);
        document.head.appendChild(script);
    });
}

/**
 * Wait for heic-to initialization
 */
async function loadHeicTo(): Promise<HeicToFunction> {
    if (window.heicTo || window.HeicTo) {
        return (window.heicTo || window.HeicTo) as HeicToFunction;
    }

    await loadScript('/ext/js/heic-to.js');

    // Wait for initialization
    let attempts = 0;
    while (attempts < 50) {
        const heicTo = window.heicTo || window.HeicTo;
        if (heicTo) return heicTo;
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }
    throw new Error('heic-to failed to initialize');
}

/**
 * Convert HEIC to Blob (JPEG)
 * Uses manually loaded heic-to.js (public/ext/js/heic-to.js)
 * Avoid Webpack bundling completely
 */
export async function convertHeicToBlob(file: File): Promise<Blob> {
    const heicTo = await loadHeicTo();

    try {
        // Use heic-to for conversion
        const result = await heicTo({
            blob: file,
            type: "image/jpeg",
            quality: 0.9
        });

        if (!result) {
            throw new Error('HEIC conversion returned null');
        }

        console.log('[HeicHandler] Conversion complete');
        return result;
    } catch (error) {
        console.error('[HeicHandler] Conversion failed', error);
        throw error;
    }
}
