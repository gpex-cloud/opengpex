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
      try {
        // 1. Try to get custom metadata from DataTransfer (sync event) first
        if (e?.clipboardData) {
          const items = e.clipboardData.items;
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type === CLIPBOARD_MIME_METADATA) {
              const text = await new Promise<string>((resolve) => item.getAsString(resolve));
              console.debug('[ClipboardService] Read metadata from DataTransfer (sync path)');
              return { metadata: JSON.parse(text) as ClipboardLayerMetadata };
            }
          }
          // No custom metadata in DataTransfer, do not rush to return the blob
          // Continue to try the Async Clipboard API, which supports Web Custom Formats
        }

        // 2. Read using the Async Clipboard API (supports Web Custom Formats)
        const clipboardItems = await navigator.clipboard.read();

        for (const item of clipboardItems) {
          // 2.1 Check internal metadata (highest priority)
          if (item.types.includes(CLIPBOARD_MIME_METADATA)) {
            const blob = await item.getType(CLIPBOARD_MIME_METADATA);
            const text = await blob.text();
            console.debug('[ClipboardService] Read metadata from Async Clipboard API');
            return { metadata: JSON.parse(text) as ClipboardLayerMetadata };
          }

          // 2.2 Check image (external paste)
          const imageType = item.types.find(t => t.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            console.debug('[ClipboardService] Read external image blob from Async Clipboard API');
            return { blob };
          }
        }

        // 3. If the Async API returns no results, fallback to the image in DataTransfer (compatible with older browsers/restricted scenarios)
        if (e?.clipboardData) {
          const items = e.clipboardData.items;
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file' && item.type.startsWith('image/')) {
              const blob = item.getAsFile();
              if (blob) {
                console.debug('[ClipboardService] Fallback: read image blob from DataTransfer');
                return { blob };
              }
            }
          }
        }
      } catch (err) {
        console.warn('[ClipboardService] Read failed:', err);
        // The Async API may fail due to permission issues, fallback to the image in DataTransfer
        if (e?.clipboardData) {
          const items = e.clipboardData.items;
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file' && item.type.startsWith('image/')) {
              const blob = item.getAsFile();
              if (blob) {
                console.debug('[ClipboardService] Fallback (after error): read image blob from DataTransfer');
                return { blob };
              }
            }
          }
        }
      }
      return null;
    }
  };
};
