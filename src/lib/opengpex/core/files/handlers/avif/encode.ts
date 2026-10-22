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
 * AVIF encode — @jsquash/avif only (isolated Worker).
 *
 * ── DESIGN DECISION (deliberate, not an oversight) ─────────────────────────
 * AVIF encoding runs EXCLUSIVELY through @jsquash/avif in a dedicated, crash-
 * isolated Worker (`./worker` → `/ext/wasm/avif/avif-worker.js`). This mirrors
 * the WebP handler's shape (encode does NOT touch the shared wasm-vips engine),
 * the only difference being that AVIF has no browser-native encoder so it uses
 * @jsquash instead of `canvas.convertToBlob`.
 *
 * WHY WE DROPPED THE vips-heif ENCODE PATH:
 *   The former dual-engine routing (vips-heif ≤16Mpx for ICC embed, @jsquash
 *   >16Mpx) was removed. wasm-vips has a fixed heap and libaom's encoder
 *   buffers exhaust it on large images; worse, an OOM inside the SHARED vips
 *   singleton corrupts it (Emscripten ABORT) and takes down every other vips
 *   consumer (TIFF/PNG/ICC) until a full page reload — with no restart path.
 *   Self-compiling vips to lift the heap cap was evaluated and judged not worth it.
 *
 * ── CONTAINER TAGGING (post-encode, in THIS file's pipeline) ────────────────
 * jsquash writes no usable colour metadata (one `nclx` colr with unspecified
 * 2/2/6 CICP) and has no ICC/EXIF options. Everything the output carries is
 * written here, post-encode, by this handler's own tooling:
 *   - SDR lanes: `patchNclxCicp` overwrites the CICP in place (sRGB → 1/13/6,
 *     Display P3 → 12/13/6) — byte length unchanged;
 *   - HDR PQ lane: the same patch with 9/16/9;
 *   - `embedIcc`: `injectAvifColourProfile` appends a `colr(prof)` box into
 *     meta/iprp/ipco and associates it with the primary item;
 *   - `preserveExif`: `injectAvifExifItem` appends an Exif item (iinf + iloc +
 *     cdsc iref + trailing mdat). Both writers rebuild the meta box and shift
 *     every existing iloc absolute offset accordingly — see avif/tagger.ts.
 * The stock-vs-verbatim ICC rule matches the JPEG/PNG/WebP encoders exactly.
 */

import type { GamutId } from '@opengpex/editor/core/types';
import type { EncodeOptions, EncodeSource } from '../../types';
import { isRawPixelSource } from '../../types';
import { bitmapToCanvas } from '../../index';
import { toCanvasColorSpace } from '@opengpex/editor/core/engine/color';
import { encodeAvifJsquash } from './worker';
import { patchNclxCicp, HDR_AVIF_CICP, SDR_SRGB_AVIF_CICP, SDR_P3_AVIF_CICP } from './cicp';
import { injectAvifColourProfile, injectAvifExifItem } from './tagger';
import { base64ToIcc, canEmbedSourceIccVerbatim, getStockIccProfile } from '../../shared/icc';
import { resetExifOrientation } from '../../metadata/tiff-ifd-reader';

/**
 * Encode a canvas/bitmap — or the HDR PQ raw lane — to AVIF.
 *
 * ── HDR PQ LANE (`egest` channel `'raw-10'`) ────────────────────────────────
 * A `RawPixelSource` at `bitDepth: 10` IS the HDR lane's product: straight
 * 10-bit PQ code values (0..1023) in BT.2020 primaries, produced by the export
 * command's terminal `unpremultiplyEncodePq10` step. It bypasses the canvas
 * entirely (a canvas would clamp to 8-bit sRGB and destroy the headroom) and
 * goes to the same isolated jsquash Worker with `bitDepth: 10`; the encoded
 * file then gets its `nclx` CICP triple patched in place to 9/16/9 so every
 * consumer reads the pixels as PQ/BT.2020 rather than SDR.
 *
 * ── COLOR CONTRACT (SDR lanes, unchanged) ───────────────────────────────────
 * Pixels arrive ALREADY in the target gamut with the target TRC applied (the
 * terminal `unpremultiplyEncodeGamut` in the export command did the single
 * source→target matrix + TRC + quantization step). This encoder performs ZERO
 * internal color conversion — it only tags the canvas to match `config.targetGamut`
 * so the browser round-trip does not reinterpret the pixels. (Wide-gamut Adobe RGB /
 * ProPhoto targets are routed to the PNG/TIFF 16-bit path upstream and never reach
 * this handler.) Colour tagging of the OUTPUT container is described in the
 * CONTAINER TAGGING note in the file header.
 *
 * `pixels` is retained in the signature for interface parity with the other
 * handlers (ImageFormatHandler), but AVIF encode no longer dispatches any vips
 * job — see the DESIGN DECISION note above.
 */
/**
 * Chroma subsampling by pixel count. 4:4:4 (`subsample: 3`) is the standing
 * fidelity policy, but the jsquash/libaom wasm encoder returns null (its
 * Emscripten heap ceiling) on roughly >16 MP payloads at 4:4:4 — observed as
 * the 48 MP HEIC→AVIF export producing no file at all. Past that threshold a
 * 4:2:0 encode that succeeds beats a 4:4:4 encode that fails, so fall back.
 * The jsquash option value is the chroma DECIMATION factor: 3 = none (4:4:4),
 * 1 = 2x2 (4:2:0).
 */
function chromaSubsampleForPixels(pixels: number): 1 | 3 {
  return pixels > 16_000_000 ? 1 : 3;
}

export async function encodeAvif(
  source: EncodeSource,
  options: EncodeOptions,
): Promise<Blob> {
  const quality = Math.round((options.quality ?? 0.80) * 100);
  const config = options.exportConfig;
  const meta = options.metadata;

  const embedIcc = config?.embedIcc ?? false;

  // ── HDR PQ lane: raw 10-bit straight to jsquash, CICP patched in place ──
  if (isRawPixelSource(source)) {
    if (source.bitDepth !== 10 || !(source.data instanceof Uint16Array)) {
      // egest never routes an SDR raw source onto AVIF (SDR takes canvas-8);
      // reaching here is a routing bug and must fail loudly.
      throw new Error('[AvifHandler] unsupported raw source for AVIF (only the 10-bit PQ lane is accepted)');
    }
    const avifBytes = await encodeAvifJsquash(source.data, source.width, source.height, {
      quality,
      speed: 6,
      bitDepth: 10,
      subsample: chromaSubsampleForPixels(source.width * source.height),
    });
    patchNclxCicp(avifBytes, HDR_AVIF_CICP);
    return new Blob([avifBytes.buffer as ArrayBuffer], { type: 'image/avif' });
  }

  // The gamut the incoming pixels ARE in. AVIF only ever receives
  // srgb / display-p3 here (wide-gamut is routed onto the PNG/TIFF raw lanes).
  const targetGamut: GamutId = (config?.targetGamut as GamutId | undefined) ?? 'srgb';

  // Pixel extraction. Pixels already carry targetGamut + its TRC — tag the canvas
  // to match so the browser round-trip does not reinterpret them. NO color
  // conversion here.
  const canvas: OffscreenCanvas | HTMLCanvasElement = source instanceof ImageBitmap
    ? bitmapToCanvas(source, toCanvasColorSpace(targetGamut))
    : source as OffscreenCanvas;

  const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rgbaData = new Uint8Array(imageData.data.buffer);

  // Single encode path — isolated @jsquash Worker, ALLOW_MEMORY_GROWTH, no size
  // limit, crash-isolated from the shared vips singleton.
  const avifBytes = await encodeAvifJsquash(rgbaData, canvas.width, canvas.height, {
    quality,
    speed: 6,
    subsample: chromaSubsampleForPixels(canvas.width * canvas.height),
  });

  // ── Container tagging (jsquash writes none of this itself) ──
  // 1. CICP: jsquash's nclx colr carries "unspecified" 2/2/6; overwrite the
  //    three u16 values in place so consumers read the pixels as sRGB or P3.
  patchNclxCicp(avifBytes, targetGamut === 'display-p3' ? SDR_P3_AVIF_CICP : SDR_SRGB_AVIF_CICP);

  // 2. ICC: verbatim source profile on a same-gamut round-trip, otherwise the
  //    stock profile for the OUTPUT gamut — identical to the JPEG/PNG/WebP rule.
  let taggedBytes = avifBytes;
  if (embedIcc) {
    const verbatim = !!meta?.raw?.icc?.data && canEmbedSourceIccVerbatim(meta?.colorSpace, targetGamut);
    const iccBytes = verbatim
      ? base64ToIcc(meta!.raw!.icc!.data)
      : getStockIccProfile(targetGamut)?.bytes;
    if (iccBytes) taggedBytes = injectAvifColourProfile(taggedBytes, iccBytes);
  }

  // 3. EXIF: passthrough the retained source TIFF block with Orientation reset
  //    (exported pixels are already upright), same as the PNG/WebP encoders.
  if (config?.preserveExif && meta?.raw?.exif) {
    const exifBytes = resetExifOrientation(base64ToIcc(meta.raw.exif));
    taggedBytes = injectAvifExifItem(taggedBytes, exifBytes);
  }

  return new Blob([taggedBytes.buffer as ArrayBuffer], { type: 'image/avif' });
}

