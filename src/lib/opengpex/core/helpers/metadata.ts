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
 * MetadataHelper: Image metadata management tool
 * Reserved for injecting render parameters, version numbers, and debugging information into exported images.
 */

import exifr from 'exifr';
// @ts-expect-error - piexifjs lacks official TypeScript declarations
import * as piexif from 'piexifjs';
import ExifReader from 'exifreader';
import { ExifData } from '../types/models';

export interface ExportMetadata {
  engine: 'canvas2d' | 'webgl' | 'wasm';
  version: string;
  renderMode: 'original' | 'tiled';
  timestamp: number;
  isSafeExport: boolean;
  viewportScale: number;
}

export const MetadataHelper = {
  /**
   * extractExif: Extract parsed EXIF data and raw piexif object
   */
  async extractExif(file: File): Promise<ExifData | undefined> {
    try {
      // 1. Extract human-readable EXIF using exifr (including makerNote for specific lens info)
      const parsed = await exifr.parse(file, { tiff: true, exif: true, makerNote: true });
      if (!parsed) return undefined;

      console.log('[MetadataHelper] Raw parsed EXIF:', parsed);

      // Aggressively search for Lens Info
      let foundLens = parsed.LensModel || parsed.Lens || parsed.LensType;
      if (!foundLens && typeof parsed === 'object') {
        // Sometimes it's deeply nested or under a different key
        for (const [key, val] of Object.entries(parsed)) {
          if (key.toLowerCase().includes('lens') && typeof val === 'string') {
            foundLens = val;
            break;
          }
        }
      }

      // Fallback to ExifReader for deeply nested Canon MakerNotes
      if (!foundLens) {
        try {
          const tags = await ExifReader.load(file);
          foundLens = tags['LensModel']?.description || tags['Lens']?.description || tags['LensType']?.description;
        } catch (e) {
          console.warn('[MetadataHelper] ExifReader fallback failed:', e);
        }
      }

      // Normalize date objects strictly to standard ISO strings
      const parseDateToISO = (rawDate: unknown): string | undefined => {
        if (!rawDate) return undefined;
        // Check if it's a Native Date or exifr custom Date polyfill with getTime
        if (typeof rawDate === 'object' && rawDate !== null && 'getTime' in rawDate && typeof (rawDate as Date).getTime === 'function') {
          const time = (rawDate as Date).getTime();
          if (!isNaN(time)) return new Date(time).toISOString();
        }
        // Fallback string parsing for raw EXIF strings
        if (typeof rawDate === 'string') {
          const normalized = rawDate.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
          const d = new Date(normalized);
          if (!isNaN(d.getTime())) return d.toISOString();
        }
        return undefined;
      };

      const exifData: ExifData = {
        Make: parsed.Make,
        Model: parsed.Model,
        DateTimeOriginal: parseDateToISO(parsed.DateTimeOriginal),
        DateTimeDigitized: parseDateToISO(parsed.DateTimeDigitized) || parseDateToISO(parsed.CreateDate),
        FNumber: parsed.FNumber,
        ExposureTime: parsed.ExposureTime,
        ISOSpeedRatings: parsed.ISO || parsed.ISOSpeedRatings,
        FocalLength: parsed.FocalLength,
        LensMake: parsed.LensMake,
        LensModel: foundLens,
        Software: parsed.Software,
        ColorSpace: parsed.ColorSpace,
        XResolution: parsed.XResolution,
        YResolution: parsed.YResolution,
        ResolutionUnit: parsed.ResolutionUnit,
        CreateDate: parseDateToISO(parsed.CreateDate),
        ModifyDate: parseDateToISO(parsed.ModifyDate),
        ExifVersion: parsed.ExifVersion ? String(parsed.ExifVersion) : undefined,
        WhiteBalance: parsed.WhiteBalance,
      };

      // 2. If it's a JPEG, also extract raw piexif obj for later injection
      if (file.type === 'image/jpeg') {
        const base64 = await this.fileToBase64(file);
        try {
          const rawPiexifObj = piexif.load(base64);
          exifData.rawPiexifObj = rawPiexifObj;
        } catch (e) {
          console.warn('[MetadataHelper] Failed to load raw piexif:', e);
        }
      }

      return exifData;
    } catch (err) {
      console.warn('[MetadataHelper] EXIF extraction failed:', err);
      return undefined;
    }
  },

  fileToBase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  base64ToBlob(base64: string, type: string = 'image/jpeg'): Blob {
    const parts = base64.split(';base64,');
    const raw = window.atob(parts[1] || parts[0]);
    const rawLength = raw.length;
    const uInt8Array = new Uint8Array(rawLength);
    for (let i = 0; i < rawLength; ++i) {
      uInt8Array[i] = raw.charCodeAt(i);
    }
    return new Blob([uInt8Array], { type });
  },

  generateExportTags(params: Partial<ExportMetadata>): string {
    const defaultMeta: ExportMetadata = {
      engine: 'canvas2d',
      version: '2.1.0-hybrid',
      renderMode: 'original',
      timestamp: Date.now(),
      isSafeExport: true,
      viewportScale: 1,
      ...params
    };
    return JSON.stringify(defaultMeta);
  },

  /**
   * injectToBlob: Inject EXIF tags and custom metadata into JPEG Blob
   */
  async injectToBlob(blob: Blob, meta: Partial<ExportMetadata>, originalExifData?: ExifData): Promise<Blob> {
    // Only process JPEG for EXIF injection via piexifjs
    if (blob.type !== 'image/jpeg') {
      return blob;
    }

    try {
      const base64 = await this.fileToBase64(blob);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const exifObj: Record<string, any> = originalExifData?.rawPiexifObj
        ? JSON.parse(JSON.stringify(originalExifData.rawPiexifObj)) 
        : { "0th": {}, "Exif": {}, "GPS": {} };

      // Initialize missing objects
      if (!exifObj["0th"]) exifObj["0th"] = {};
      if (!exifObj["Exif"]) exifObj["Exif"] = {};

      // Inject custom meta into 0th IFD Software tag
      const tagsString = this.generateExportTags(meta);
      exifObj["0th"][piexif.ImageIFD.Software] = tagsString;

      const exifStr = piexif.dump(exifObj);
      const newBase64 = piexif.insert(exifStr, base64);
      
      return this.base64ToBlob(newBase64, 'image/jpeg');
    } catch (e) {
      console.warn('[MetadataHelper] Failed to inject EXIF:', e);
      return blob;
    }
  }
};
