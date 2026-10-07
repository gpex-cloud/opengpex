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

import { ClipboardService, ClipboardLayerMetadata } from '@opengpex/editor/core/types';

/**
 * Clipboard Metadata v1 Protocol
 * Note: Custom types must start with 'web ' to be allowed for writing by the browser (W3C Web Custom Types)
 */
export const CLIPBOARD_MIME_METADATA = 'web application/x-opengpex-layer-v1';

/**
 * ClipboardService Implementation: Pure system clipboard driver
 */
export const createClipboardService = (): ClipboardService => {
  return {
    writeBlob: async (blob: Blob, metadata: ClipboardLayerMetadata) => {
      try {
        const metadataBlob = new Blob([JSON.stringify(metadata)], { type: CLIPBOARD_MIME_METADATA });

        const item = new ClipboardItem({
          [CLIPBOARD_MIME_METADATA]: metadataBlob,
          'image/png': blob,
          'text/plain': new Blob(['OpenGPEX Layer Data'], { type: 'text/plain' })
        });

        await navigator.clipboard.write([item]);
      } catch (err) {
        console.error('[ClipboardService] Write failed:', err);
        throw err;
      }
    },

    writeByUrl: async (url: string, metadata: ClipboardLayerMetadata) => {
      try {
        const res = await fetch(url);
        const blob = await res.blob();

        const metadataBlob = new Blob([JSON.stringify(metadata)], { type: CLIPBOARD_MIME_METADATA });

        const item = new ClipboardItem({
          [CLIPBOARD_MIME_METADATA]: metadataBlob,
          'image/png': blob,
          'text/plain': new Blob(['OpenGPEX Layer Data'], { type: 'text/plain' })
        });

        await navigator.clipboard.write([item]);
      } catch (err) {
        console.error('[ClipboardService] WriteByUrl failed:', err);
        throw err;
      }
    },

    read: async (e?: ClipboardEvent) => {
      // ═══ CRITICAL: Synchronous extraction from DataTransfer ═══
      // The browser invalidates/detaches e.clipboardData once an asynchronous tick occurs.
      // Any File/Blob references or string promises from e.clipboardData MUST be acquired
      // synchronously before any `await` (such as navigator.clipboard.read()).
      let syncBlob: Blob | undefined = undefined;
      let syncMetaPromise: Promise<string> | undefined = undefined;

      if (e?.clipboardData) {
        // 1. Scan items synchronously
        const items = e.clipboardData.items;
        if (items) {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type === CLIPBOARD_MIME_METADATA) {
              syncMetaPromise = new Promise<string>((resolve) => item.getAsString(resolve));
            } else if (!syncBlob && item.kind === 'file') {
              const file = item.getAsFile();
              if (file && (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|svg)$/i.test(file.name))) {
                syncBlob = file;
              }
            }
          }
        }

        // 2. Scan files collection synchronously as well (common for Finder / WeChat file copy)
        if (!syncBlob && e.clipboardData.files && e.clipboardData.files.length > 0) {
          for (let i = 0; i < e.clipboardData.files.length; i++) {
            const file = e.clipboardData.files[i];
            if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|svg)$/i.test(file.name)) {
              syncBlob = file;
              break;
            }
          }
        }
      }

      try {
        // 1. If DataTransfer had internal layer metadata, resolve it directly
        if (syncMetaPromise) {
          const text = await syncMetaPromise;
          const metadata = JSON.parse(text) as ClipboardLayerMetadata;
          return { metadata, blob: syncBlob };
        }

        // 2. Try reading via Async Clipboard API (for Web Custom Formats or screenshot blobs)
        if (typeof navigator !== 'undefined' && navigator.clipboard?.read) {
          try {
            const clipboardItems = await navigator.clipboard.read();

            for (const item of clipboardItems) {
              // 2.1 Internal OpenGPEX layer metadata (Web Custom Format)
              if (item.types.includes(CLIPBOARD_MIME_METADATA)) {
                const metaBlob = await item.getType(CLIPBOARD_MIME_METADATA);
                const text = await metaBlob.text();
                const metadata = JSON.parse(text) as ClipboardLayerMetadata;
                const imageType = item.types.find(t => t.startsWith('image/'));
                const blob = imageType ? await item.getType(imageType) : syncBlob;
                return { metadata, blob };
              }

              // 2.2 Async image blob (fallback if no syncBlob was provided by DataTransfer)
              if (!syncBlob) {
                const imageType = item.types.find(t => t.startsWith('image/'));
                if (imageType) {
                  const blob = await item.getType(imageType);
                  return { blob };
                }
              }
            }
          } catch (asyncErr) {
            // Permission denied, unfocused document, or unsupported format
            console.debug('[ClipboardService] Async Clipboard API fallback to DataTransfer:', asyncErr);
          }
        }

        // 3. If we captured an image file from DataTransfer (WeChat, Finder, etc.), return it!
        if (syncBlob) {
          return { blob: syncBlob };
        }
      } catch (err) {
        console.warn('[ClipboardService] Clipboard read error:', err);
        if (syncBlob) {
          return { blob: syncBlob };
        }
      }

      return null;
    }
  };
};
