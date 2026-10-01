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
 * PNG decode — pure pixel producer driven by the pre-resolved IngestDecision.
 *
 * The handler no longer sniffs metadata or derives a colour
 * strategy of its own. The FileService entry injects `metadata` + `decision`
 * (the single `resolveIngestDecision` call), and this function simply executes
 * the assigned `decision.decodeChannel`, delegating the 8-bit wide-gamut fold to
 * the shared `decodeWideGamut8` and the >8-bit path to a single LibVips
 * pass. `colorIdentity` / `sourceBlob` are mounted by the entry — hence the
 * `Omit` return.
 *
 * PNG-specific vs. the JPEG pilot: PNG's `decision.applyOrientation` is
 * 'explicit' (neither the browser nor vips auto-rotates PNG pixels), so this
 * decoder still runs `applyExifOrientation` after producing the displayBlob.
 */

import type { ImageMetadata, DecodedPayload } from '../../types';
import type { IngestDecision } from '../../strategy';
import { iccToBase64, parseIccProfileName } from '../../shared/icc';
import { getLibVips } from '../../shared/lib-vips';
import { decodeWideGamut8 } from '../../shared/lib-custom';
import { applyExifOrientation, rotateNakedRgba } from '../../shared/orientation';
import { readImageDimensions, rgbaToBlob } from '../../utils';

/**
 * Decode a PNG file by executing the entry-resolved ingest decision.
 */
export async function decodePng(
  file: File,
  metadata: ImageMetadata,
  decision: IngestDecision,
): Promise<DecodedPayload[]> {

  let displayBlob: Blob = file;
  let dimensions: { w: number; h: number };
  let highDepthSource: DecodedPayload['highDepthSource'];

  switch (decision.decodeChannel) {
    case 'image-bitmap': {
      // 8-bit sRGB / Display-P3 / grayscale: browser-native decode is sufficient,
      // the original file bytes remain the verbatim displayBlob.
      dimensions = await readImageDimensions(file);
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

    case 'vips': {
      // >8-bit PNG (any gamut): a SINGLE LibVips pass produces BOTH the 8-bit
      // display proxy AND the full-precision f16 naked pixels. This replaces the
      // former two-decode shape — a browser-native 8-bit display (old 'none'
      // branch) plus a separate `getLibVips().decode({ wantHighDepth })` for the
      // f16 line — with one preserve-mode vips decode (mirrors the TIFF handler).
      //
      // `preserveColorSpace: true` keeps vips's 8-bit output in the SOURCE-encoded
      // pixels (no colour management), so the proxy's display colour is decided
      // here per gamut: non-wide follows the source, wide folds to P3.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const gamut = decision.colorIdentity.gamut;
      const { width, height, displayBlob: blob, highDepth } = await getLibVips().decode(bytes, {
        preserveColorSpace: true,
        wantHighDepth: true,
        gamut,
      });
      dimensions = { w: width, h: height };
      displayBlob = blob!;

      // The `sourceBitDepth > 8` guard lives in the worker, so an 8-bit source
      // (or an 8-bit-with-raw asset) yields no highDepth and keeps the 8-bit path.
      if (highDepth) {
        // BARE payload — container/trc/gamut live on the sibling `colorIdentity`
        // the entry injects (Path B), so they are no longer carried per-page here.
        highDepthSource = {
          data: highDepth.data,
          width: highDepth.width,
          height: highDepth.height,
        };
      }
      break;
    }

    case 'vips-icc': {
      // CMYK / unknown profiles (uncommon for PNG, but retained): full LibVips
      // ICC engine. Mirrors the JPEG pilot's vips-icc branch.
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
      // PNG only ever routes to the four channels above; any other channel is a
      // decision/handler mismatch that must fail loudly rather than silently.
      throw new Error(`decodePng: unexpected decodeChannel '${decision.decodeChannel}'`);
  }

  // ── EXIF Orientation correction (PNG-specific: applyOrientation is 'explicit') ──
  // Unlike JPEG (auto-uprighted by the browser), neither createImageBitmap nor
  // vips rotates PNG pixels. If the PNG has an eXIf/XMP chunk with Orientation ≠ 1,
  // we must manually rotate the produced displayBlob (and swap dimensions).
  const orientation = metadata.capture?.orientation;
  if (orientation && orientation !== 1) {
    const rotated = await applyExifOrientation(displayBlob, dimensions, orientation);
    displayBlob = rotated.blob;
    dimensions = rotated.dimensions;

    // The naked high-depth buffer must be uprighted TOO, or it stays pre-EXIF
    // while the display proxy is post-EXIF (mismatched geometry for orientation
    // 5-8, mirrored/inverted appearance for 2/3/4). Rotate it with ITS OWN
    // width/height — `dimensions` above is already the rotated display dims.
    if (highDepthSource) {
      const rotatedNaked = rotateNakedRgba(
        highDepthSource.data, highDepthSource.width, highDepthSource.height, orientation,
      );
      highDepthSource = {
        data: rotatedNaked.data,
        width: rotatedNaked.width,
        height: rotatedNaked.height,
      };
    }
  }

  return [{ displayBlob, width: dimensions.w, height: dimensions.h, index: 0, highDepthSource }];
}
