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
 * JPEG decode — pure pixel producer driven by the pre-resolved IngestDecision.
 *
 * The handler no longer sniffs metadata or derives a colour
 * strategy of its own. The FileService entry injects `metadata` + `decision`
 * (the single `resolveIngestDecision` call), and this function simply executes
 * the assigned `decision.decodeChannel` — browser passthrough, the `1-gm`
 * gain-map master lift (`shared/gain-map`), the 8-bit wide-gamut fold
 * (`decodeWideGamut8`) or the vips ICC engine. `colorIdentity` / `sourceBlob`
 * are mounted by the entry — hence the `Omit` return.
 */

import type { ImageMetadata, DecodedPayload } from '../../types';
import type { IngestDecision } from '../../strategy';
import { iccToBase64, parseIccProfileName } from '../../shared/icc';
import { getLibVips } from '../../shared/lib-vips';
import { decodeWideGamut8 } from '../../shared/lib-custom';
import { liftBaseToF16 } from '../../shared/gain-map';
import { readImageDimensions, rgbaToBlob } from '../../utils';

/**
 * Decode a JPEG file by executing the entry-resolved ingest decision.
 */
export async function decodeJpeg(
  file: File,
  metadata: ImageMetadata,
  decision: IngestDecision,
): Promise<DecodedPayload[]> {

  let displayBlob: Blob = file;
  let dimensions: { w: number; h: number };
  let highDepthSource: DecodedPayload['highDepthSource'];

  switch (decision.decodeChannel) {
    case 'image-bitmap': {
      // Standard sRGB / Display-P3 8-bit: browser-native decode is sufficient,
      // the original file bytes remain the verbatim displayBlob.
      dimensions = await readImageDimensions(file);
      break;
    }

    case 'jpeg-hdr': {
      // Gain-map carrier (1-gm): the original bytes STAY the display proxy (a
      // JPEG is browser-native; a transcode could only degrade it), and the
      // master is the SDR base lifted to linear f16 — the gain map is NOT
      // applied here (see liftBaseToF16's header for why the bake is wrong).
      // Decode options mirror the engine's own displayBlob consumption
      // (SourceBitmapCache: EXIF-uprighted, browser-managed colour) so the
      // master is co-oriented and pixel-identical in extent to the proxy.
      dimensions = await readImageDimensions(file);
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        // The decision declares the f16 identity on this lane; the lift can
        // only fail on a decoder/decision mismatch, which fails loudly.
        if (decision.colorIdentity.dataFormat !== 'rgba16float') {
          throw new Error("decodeJpeg: 'jpeg-hdr' decision must declare rgba16float");
        }
        highDepthSource = liftBaseToF16(rgba, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
      break;
    }

    case 'wide-gamut-8': {
      // 8-bit wide-gamut (Adobe RGB / ProPhoto): decode with browser colour management
      // OFF, lift f16 naked line AND fold P3 preview in one call.
      const decoded = await decodeWideGamut8(
        file,
        decision.colorIdentity.gamut as 'adobe-rgb' | 'prophoto-rgb',
      );
      dimensions = { w: decoded.width, h: decoded.height };
      displayBlob = decoded.displayBlob;
      // Bare payload only — container/trc/gamut live on the sibling `colorIdentity`
      // the entry injects (Path B).
      highDepthSource = {
        data: decoded.highDepthSource.data,
        width: decoded.highDepthSource.width,
        height: decoded.highDepthSource.height,
      };
      break;
    }

    case 'vips-icc': {
      // CMYK / custom ICC profiles / unknown spaces: full LibVips ICC engine.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { width, height, data, iccProfileData } = await getLibVips().iccToSrgb(bytes);
      dimensions = { w: width, h: height };

      // Vips reliably extracts ICC — backfill metadata if the header sniff missed it.
      if (iccProfileData && iccProfileData.length > 0 && !metadata.raw.icc) {
        metadata.raw.icc = {
          data: iccToBase64(iccProfileData),
          name: parseIccProfileName(iccProfileData) || 'Embedded',
        };
      }
      displayBlob = await rgbaToBlob(data, width, height);
      break;
    }

    default:
      // JPEG only ever routes to the four channels above; any other channel is
      // a decision/handler mismatch that must fail loudly rather than silently.
      throw new Error(`decodeJpeg: unexpected decodeChannel '${decision.decodeChannel}'`);
  }

  return [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0, highDepthSource }];
}
