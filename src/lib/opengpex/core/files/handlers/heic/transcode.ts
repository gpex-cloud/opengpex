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
 * HEIC → JPEG Conversion (dynamic script loading).
 *
 * Uses the heic-to library loaded from /ext/js/heic-to.js.
 * heic-to uses the browser's native HEIC decoder where available,
 * falling back to a JS-based decoder.
 *
 * Future: migrate to Worker-based libheif-wasm for better perf.
 */

let heicToLoaded = false;

/**
 * Dynamically loads heic-to library and converts HEIC to JPEG Blob.
 */
export async function convertHeicToBlob(file: File): Promise<Blob> {
  // Ensure heic-to script is loaded
  if (!heicToLoaded && typeof window !== 'undefined') {
    if (!(window as unknown as Record<string, unknown>).heicTo
      && !(window as unknown as Record<string, unknown>).HeicTo) {
      await loadScript('/ext/js/heic-to.js');
      // Wait for global to initialize (heic-to may set up asynchronously)
      let retries = 0;
      while (retries < 50) {
        if ((window as unknown as Record<string, unknown>).heicTo
          || (window as unknown as Record<string, unknown>).HeicTo) break;
        await new Promise(r => setTimeout(r, 100));
        retries++;
      }
    }
    heicToLoaded = true;
  }

  // heic-to exposes as window.heicTo or window.HeicTo
  const heicToFn = ((window as unknown as Record<string, unknown>).heicTo
    || (window as unknown as Record<string, unknown>).HeicTo) as
    ((opts: { blob: Blob; type: string; quality: number }) => Promise<Blob>) | undefined;

  if (!heicToFn) {
    throw new Error('[HeicHandler] heic-to library not available');
  }

  const blob = await heicToFn({
    blob: file,
    type: 'image/jpeg',
    quality: 0.9,
  });

  if (!blob) throw new Error('HEIC conversion returned null');
  return blob;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}
