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

import { EditorContextValue, LocalShape } from '@opengpex/editor/core/types';

export interface ExportOptions {
    format: string;
    quality?: number;
    isClipMode: boolean;
    cropBox?: LocalShape;
}

/**
 * FormatConverter: A facade service for handling different export file formats.
 * It routes the export request either to the core's native export (for PNG/JPG/WEBP)
 * or to dedicated plugin workers (for AVIF, TIFF, etc.) via the zero-copy raw channel.
 */
export class FormatConverter {
    static async export(ctx: EditorContextValue, options: ExportOptions): Promise<Blob> {
        if (options.format === 'image/avif') {
            return this.encodeAvif(ctx, options);
        }

        // Future formats like TIFF can be added here seamlessly:
        // if (options.format === 'image/tiff') return this.encodeTiff(ctx, options);

        // Default fallback to native formats supported directly by the core engine / browser
        return this.encodeNative(ctx, options);
    }

    private static async encodeNative(ctx: EditorContextValue, options: ExportOptions): Promise<Blob> {
        const { activeFrame, pixels } = ctx;
        const { format, quality, isClipMode, cropBox } = options;
        const q = quality ? quality / 100 : 0.92;

        if (isClipMode && cropBox) {
            return await pixels.render.shapeToBlob(activeFrame!, cropBox, { format, quality: q }) as Blob;
        }
        return await pixels.render.frameToBlob(activeFrame!, { format, quality: q }) as Blob;
    }

    private static async encodeAvif(ctx: EditorContextValue, options: ExportOptions): Promise<Blob> {
        const { activeFrame, pixels } = ctx;
        const { isClipMode, cropBox, quality } = options;

        const bitmap = (isClipMode && cropBox
            ? await pixels.render.shapeToBlob(activeFrame!, cropBox, { format: 'raw', quality: 1 })
            : await pixels.render.frameToBlob(activeFrame!, { format: 'raw', quality: 1 })) as ImageBitmap;

        const avifWorker = new Worker(new URL('../workers/avif.worker.ts', import.meta.url), { type: 'module' });

        return await new Promise<Blob>((resolve, reject) => {
            avifWorker.onmessage = (e) => {
                if (e.data.success) {
                    resolve(e.data.blob);
                } else {
                    reject(new Error(e.data.error || 'AVIF Encoding failed in plugin worker'));
                }
                avifWorker.terminate();
            };
            avifWorker.postMessage({
                action: 'ENCODE_AVIF',
                payload: { bitmap, quality: quality ? quality / 100 : 0.92 }
            }, [bitmap]); // Zero-copy transfer
        });
    }
}
