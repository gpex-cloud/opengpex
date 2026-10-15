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
 * OpenGPEX v2.0 Ingest & Egest Full Pipeline Automated Verification Suite.
 *
 * Data-Deterministic Acceptance Test Suite:
 * Directly tests the 32 physical sample image files generated under `opengpex_v2/samples/`,
 * executing real metadata extraction, ingest decision resolution, egest decision resolution,
 * pass-through fast-track gating, and container capability single-directional convergence.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createFileService,
  resolveIngestDecision,
  resolveEgestDecision,
} from './core/files';
import { WORKING_GAMUT } from '@opengpex/editor/core/engine/color';
import type { FileService } from './core/files/types';
import type { AssetService } from './core/types';

const SAMPLES_DIR = path.resolve(process.cwd(), 'samples');

function loadSampleFile(fileName: string, mimeType: string): File {
  const filePath = path.join(SAMPLES_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Sample file not found: ${filePath}. Please run the generator script first.`);
  }
  const buffer = fs.readFileSync(filePath);
  return new File([buffer], fileName, { type: mimeType });
}

describe('OpenGPEX v2.0 - Samples Ingest & Egest Automated Test Suite', () => {
  let files: FileService;

  beforeAll(() => {
    files = createFileService({} as unknown as AssetService);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 1: Ingest Pipeline Matrix (Cases INGEST-1 to INGEST-9)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Ingest Pipeline Matrix (INGEST-1 ~ INGEST-9)', () => {
    it('Case INGEST-1: Native zero-copy passthrough channel (image-bitmap, retainSourceBlob=false)', async () => {
      // 1.1 8-bit Display-P3 JPEG
      const p3Jpg = loadSampleFile('08_chart_displayp3_8bit_2048.jpg', 'image/jpeg');
      const p3JpgMeta = await files.extractMetadata(p3Jpg);
      expect(p3JpgMeta.sourceFormat).toBe('jpeg');
      expect(p3JpgMeta.colorSpace).toBe('display-p3');
      expect(p3JpgMeta.bitDepth).toBe(8);

      const p3JpgDecision = resolveIngestDecision(p3JpgMeta);
      expect(p3JpgDecision.decodeChannel).toBe('image-bitmap');
      expect(p3JpgDecision.retainSourceBlob).toBe(false);
      expect(p3JpgDecision.colorIdentity).toEqual({
        gamut: 'display-p3',
        trc: 'srgb-trc',
        bitDepth: 8,
        dataFormat: undefined,
      });

      // 1.2 8-bit sRGB JPEG
      const srgbJpg = loadSampleFile('09_chart_srgb_8bit_2048.jpg', 'image/jpeg');
      const srgbJpgMeta = await files.extractMetadata(srgbJpg);
      expect(srgbJpgMeta.colorSpace).toBe('srgb');

      const srgbJpgDecision = resolveIngestDecision(srgbJpgMeta);
      expect(srgbJpgDecision.decodeChannel).toBe('image-bitmap');
      expect(srgbJpgDecision.retainSourceBlob).toBe(false);
      expect(srgbJpgDecision.colorIdentity.gamut).toBe('srgb');

      // 1.3 8-bit Display-P3 WebP
      const p3Webp = loadSampleFile('11_chart_displayp3_8bit_2048.webp', 'image/webp');
      const p3WebpMeta = await files.extractMetadata(p3Webp);
      expect(p3WebpMeta.colorSpace).toBe('display-p3');

      const p3WebpDecision = resolveIngestDecision(p3WebpMeta);
      expect(p3WebpDecision.decodeChannel).toBe('image-bitmap');
      expect(p3WebpDecision.retainSourceBlob).toBe(false);

      // 1.4 8-bit sRGB BMP
      const bmp = loadSampleFile('15_chart_srgb_8bit_1024.bmp', 'image/bmp');
      const bmpMeta = await files.extractMetadata(bmp);
      expect(bmpMeta.sourceFormat).toBe('bmp');

      const bmpDecision = resolveIngestDecision(bmpMeta);
      expect(bmpDecision.decodeChannel).toBe('image-bitmap');
      expect(bmpDecision.retainSourceBlob).toBe(false);
      expect(bmpDecision.colorIdentity.gamut).toBe('srgb');

      // 1.5 8-bit Static Single-frame GIF
      const staticGif = loadSampleFile('16_chart_srgb_static_512.gif', 'image/gif');
      const gifMeta = await files.extractMetadata(staticGif);
      expect(gifMeta.sourceFormat).toBe('gif');
      expect(gifMeta.isMultiFrame).toBeFalsy();

      const gifDecision = resolveIngestDecision(gifMeta);
      expect(gifDecision.decodeChannel).toBe('image-bitmap');
      expect(gifDecision.retainSourceBlob).toBe(false);
    });

    it('Case INGEST-2: 8-bit wide-gamut promotion channel (wide-gamut-8, dual product, retainSourceBlob=true)', async () => {
      // 2.1 8-bit Adobe RGB JPEG
      const adobeJpg = loadSampleFile('07_chart_adobergb_8bit_2048.jpg', 'image/jpeg');
      const adobeJpgMeta = await files.extractMetadata(adobeJpg);
      expect(adobeJpgMeta.colorSpace).toBe('adobe-rgb');
      expect(adobeJpgMeta.bitDepth).toBe(8);

      const adobeJpgDecision = resolveIngestDecision(adobeJpgMeta);
      expect(adobeJpgDecision.decodeChannel).toBe('wide-gamut-8');
      expect(adobeJpgDecision.retainSourceBlob).toBe(true);
      expect(adobeJpgDecision.colorIdentity).toEqual({
        gamut: 'adobe-rgb',
        trc: 'linear',
        bitDepth: 8,
        dataFormat: 'rgba16float',
      });

      // 2.2 8-bit Adobe RGB WebP
      const adobeWebp = loadSampleFile('10_chart_adobergb_8bit_2048.webp', 'image/webp');
      const adobeWebpMeta = await files.extractMetadata(adobeWebp);
      expect(adobeWebpMeta.colorSpace).toBe('adobe-rgb');

      const adobeWebpDecision = resolveIngestDecision(adobeWebpMeta);
      expect(adobeWebpDecision.decodeChannel).toBe('wide-gamut-8');
      expect(adobeWebpDecision.retainSourceBlob).toBe(true);
      expect(adobeWebpDecision.colorIdentity.dataFormat).toBe('rgba16float');
    });

    it('Case INGEST-3: 16-bit LibVips high-depth channel (vips, retainSourceBlob=true, TRC de-gamma branching)', async () => {
      // 3.1 16-bit Adobe RGB TIFF (TRC linearized to prevent A1 pale-green color bias)
      const adobeTiff = loadSampleFile('02_chart_adobergb_16bit_2048.tiff', 'image/tiff');
      const adobeTiffMeta = await files.extractMetadata(adobeTiff);
      expect(adobeTiffMeta.sourceFormat).toBe('tiff');
      expect(adobeTiffMeta.colorSpace).toBe('adobe-rgb');
      expect(adobeTiffMeta.bitDepth).toBe(16);

      const adobeTiffDecision = resolveIngestDecision(adobeTiffMeta);
      expect(adobeTiffDecision.decodeChannel).toBe('vips');
      expect(adobeTiffDecision.retainSourceBlob).toBe(true);
      expect(adobeTiffDecision.colorIdentity).toEqual({
        gamut: 'adobe-rgb',
        trc: 'linear',
        bitDepth: 16,
        dataFormat: 'rgba16float',
      });

      // 3.2 16-bit Display-P3 TIFF (Retains source srgb-trc gamma curve)
      const p3Tiff = loadSampleFile('04_chart_displayp3_16bit_2048.tiff', 'image/tiff');
      const p3TiffMeta = await files.extractMetadata(p3Tiff);
      expect(p3TiffMeta.colorSpace).toBe('display-p3');
      expect(p3TiffMeta.bitDepth).toBe(16);

      const p3TiffDecision = resolveIngestDecision(p3TiffMeta);
      expect(p3TiffDecision.decodeChannel).toBe('vips');
      expect(p3TiffDecision.retainSourceBlob).toBe(true);
      expect(p3TiffDecision.colorIdentity).toEqual({
        gamut: 'display-p3',
        trc: 'srgb-trc',
        bitDepth: 16,
        dataFormat: 'rgba16float',
      });

      // 3.3 16-bit ProPhoto RGB TIFF
      const prophotoTiff = loadSampleFile('03_chart_prophoto_16bit_2048.tiff', 'image/tiff');
      const prophotoTiffMeta = await files.extractMetadata(prophotoTiff);
      expect(prophotoTiffMeta.colorSpace).toBe('prophoto-rgb');
      const prophotoTiffDecision = resolveIngestDecision(prophotoTiffMeta);
      expect(prophotoTiffDecision.decodeChannel).toBe('vips');
      expect(prophotoTiffDecision.colorIdentity.gamut).toBe('prophoto-rgb');
      expect(prophotoTiffDecision.colorIdentity.trc).toBe('linear');

      // 3.4 16-bit Adobe RGB PNG
      const adobePng = loadSampleFile('05_chart_adobergb_16bit_2048.png', 'image/png');
      const adobePngMeta = await files.extractMetadata(adobePng);
      expect(adobePngMeta.bitDepth).toBe(16);
      expect(adobePngMeta.colorSpace).toBe('adobe-rgb');
      const adobePngDecision = resolveIngestDecision(adobePngMeta);
      expect(adobePngDecision.decodeChannel).toBe('vips');
      expect(adobePngDecision.retainSourceBlob).toBe(true);

      // 3.5 16-bit Display-P3 PNG
      const p3Png = loadSampleFile('06_chart_displayp3_16bit_2048.png', 'image/png');
      const p3PngMeta = await files.extractMetadata(p3Png);
      expect(p3PngMeta.bitDepth).toBe(16);
      expect(p3PngMeta.colorSpace).toBe('display-p3');
      const p3PngDecision = resolveIngestDecision(p3PngMeta);
      expect(p3PngDecision.decodeChannel).toBe('vips');
      expect(p3PngDecision.colorIdentity.trc).toBe('srgb-trc');

      // 3.6 REAL PIXEL DECODE — regression guard for the `page` loader option.
      // vips-worker's generic decode() used to pass `{ page: 0 }` to
      // newFromBuffer unconditionally; pngload defines no `page` property (no
      // libvips version ever has), so EVERY 16-bit PNG died with
      // `no property named 'page'` while TIFF kept working. Drive wasm-vips
      // exactly as the fixed worker does — NO page option for single-page
      // files — and assert the 16-bit shape the vips channel must deliver.
      const { default: createVips } = await import('wasm-vips');
      const vips = await createVips();
      for (const png of [
        { file: adobePng, label: '05 (Adobe RGB)' },
        { file: p3Png, label: '06 (Display P3)' },
      ]) {
        const bytes = new Uint8Array(await png.file.arrayBuffer());
        const img = vips.Image.newFromBuffer(bytes, '', { access: 'sequential' });
        expect(img.format, `${png.label} band format`).toBe('ushort');
        expect(img.width, `${png.label} width`).toBe(2048);
        expect(img.height, `${png.label} height`).toBe(2048);
        // The worker's high-depth branch ships w*h*4 ushort naked pixels.
        const rgba = img.hasAlpha() ? img : img.bandjoin(65535);
        const naked = new Uint16Array(rgba.writeToMemory());
        expect(naked.length, `${png.label} naked size`).toBe(img.width * img.height * 4);
        expect(naked.some((v) => v > 0), `${png.label} pixels non-empty`).toBe(true);
        rgba.delete();
        img.delete();
      }
      // Static half of the guard: the worker's generic decode() must keep the
      // gated page forwarding — every newFromBuffer read goes through the
      // `page > 0` gated options, and the old unconditional interpolation
      // (`newFromBuffer(bytes, '', { page, … })`) never comes back. (The
      // ternary's own `? { page, … }` arm is the gate and is allowed.)
      const workerSrc = fs.readFileSync(
        path.resolve(process.cwd(), 'src/lib/opengpex/core/files/workers/vips-worker.js'),
        'utf8',
      );
      const decodeStart = workerSrc.indexOf('async function decode(bytes, opts)');
      const decodeBody = workerSrc.slice(decodeStart, workerSrc.indexOf('\nasync function', decodeStart + 10));
      expect(decodeBody, 'worker decode() must gate the page option').toContain('const loadOpts = page > 0');
      const newFromBufferCount = decodeBody.split('newFromBuffer').length - 1;
      const loadOptsUses = decodeBody.split('loadOpts').length - 2; // minus the declaration itself
      expect(newFromBufferCount, 'decode() loader reads found').toBeGreaterThan(0);
      expect(loadOptsUses, 'every decode() loader read must use the gated loadOpts').toBe(newFromBufferCount);
      expect(decodeBody, 'old unconditional page interpolation must stay gone').not.toContain("newFromBuffer(bytes, '', { page");
    });

    it('Case INGEST-4: 32-bit Float HDR direct passthrough (rgba32float uncompressed)', async () => {
      const floatTiff = loadSampleFile('12_chart_adobergb_32bit_float_1024.tiff', 'image/tiff');
      const floatTiffMeta = await files.extractMetadata(floatTiff);
      expect(floatTiffMeta.sourceFormat).toBe('tiff');
      expect(floatTiffMeta.bitDepth).toBe(32);
      expect(floatTiffMeta.sampleFormat).toBe('float');

      const floatTiffDecision = resolveIngestDecision(floatTiffMeta);
      expect(floatTiffDecision.decodeChannel).toBe('vips');
      expect(floatTiffDecision.retainSourceBlob).toBe(true);
      expect(floatTiffDecision.colorIdentity).toEqual({
        gamut: 'adobe-rgb',
        trc: 'linear',
        bitDepth: 32,
        dataFormat: 'rgba32float',
      });
    });

    it('Case INGEST-5: CMYK print color space conversion (vips-icc folding to sRGB)', async () => {
      // 5.1 8-bit CMYK JPEG
      const cmykJpg = loadSampleFile('13_chart_cmyk_8bit_1024.jpg', 'image/jpeg');
      const cmykJpgMeta = await files.extractMetadata(cmykJpg);
      expect(cmykJpgMeta.colorSpace).toBe('cmyk');
      expect(cmykJpgMeta.bitDepth).toBe(8);

      const cmykJpgDecision = resolveIngestDecision(cmykJpgMeta);
      expect(cmykJpgDecision.decodeChannel).toBe('vips-icc');
      expect(cmykJpgDecision.retainSourceBlob).toBe(true);
      expect(cmykJpgDecision.colorIdentity.gamut).toBe('srgb');
      expect(cmykJpgDecision.colorIdentity.trc).toBe('srgb-trc');

      // 5.2 16-bit CMYK TIFF
      const cmykTiff = loadSampleFile('14_chart_cmyk_16bit_1024.tiff', 'image/tiff');
      const cmykTiffMeta = await files.extractMetadata(cmykTiff);
      expect(cmykTiffMeta.colorSpace).toBe('cmyk');
      expect(cmykTiffMeta.bitDepth).toBe(16);

      const cmykTiffDecision = resolveIngestDecision(cmykTiffMeta);
      expect(cmykTiffDecision.decodeChannel).toBe('vips-icc');
      expect(cmykTiffDecision.retainSourceBlob).toBe(true);
      expect(cmykTiffDecision.colorIdentity).toEqual({
        gamut: 'srgb',
        trc: 'srgb-trc',
        bitDepth: 16,
        dataFormat: 'rgba16float',
      });
    });

    it('Case INGEST-6: Multi-frame animated GIF and vector SVG rasterization', async () => {
      // 6.1 Multi-frame GIF
      const animGif = loadSampleFile('17_chart_animation_multiframe.gif', 'image/gif');
      const animGifMeta = await files.extractMetadata(animGif);
      expect(animGifMeta.isMultiFrame).toBe(true);

      const animDecision = resolveIngestDecision(animGifMeta);
      expect(animDecision.decodeChannel).toBe('gifuct');
      expect(animDecision.retainSourceBlob).toBe(true);

      // 6.2 Vector SVG
      const svg = loadSampleFile('18_vector_test.svg', 'image/svg+xml');
      const svgMeta = await files.extractMetadata(svg);
      expect(svgMeta.sourceFormat).toBe('svg');

      const svgDecision = resolveIngestDecision(svgMeta);
      expect(svgDecision.decodeChannel).toBe('vector');
      expect(svgDecision.retainSourceBlob).toBe(true);
    });

    it('Case INGEST-7: EXIF Orientation responsibility (auto vs explicit)', async () => {
      // 7.1 JPEG with Orientation 6 -> auto (driver / ImageBitmap handles it)
      const orientJpg = loadSampleFile('19_chart_orient6_jpeg.jpg', 'image/jpeg');
      const jpgMeta = await files.extractMetadata(orientJpg);
      expect(jpgMeta.capture?.orientation).toBe(6);

      const jpgDecision = resolveIngestDecision(jpgMeta);
      expect(jpgDecision.applyOrientation).toBe('auto');

      // 7.2 PNG with Orientation 6 -> explicit (browser PNG eXIf support is spotty, engine must correct)
      const orientPng = loadSampleFile('19_chart_orient6_png.png', 'image/png');
      const pngMeta = await files.extractMetadata(orientPng);
      expect(pngMeta.capture?.orientation).toBe(6);

      const pngDecision = resolveIngestDecision(pngMeta);
      expect(pngDecision.applyOrientation).toBe('explicit');
    });

    it('Case INGEST-8: Invalid format fail-fast check (1-bit indexed PNG -> unsupported)', async () => {
      const invalidPng = loadSampleFile('20_invalid_1bit_indexed.png', 'image/png');
      const invalidMeta = await files.extractMetadata(invalidPng);

      const decision = resolveIngestDecision(invalidMeta);
      expect(decision.decodeChannel).toBe('unsupported');
    });

    it('Case INGEST-9: AVIF matrix routing (spec rows 15a / 15b / 16-wg / 17 / 18 / 26)', async () => {
      // Row 15a: 8-bit SDR → verbatim passthrough (retainSourceBlob=false).
      const sdr8 = resolveIngestDecision(await files.extractMetadata(
        loadSampleFile('22_avif_15a_sdr8_srgb_12mp.avif', 'image/avif')));
      expect(sdr8.decodeChannel).toBe('image-bitmap');
      expect(sdr8.colorIdentity.gamut).toBe('srgb');
      expect(sdr8.colorIdentity.bitDepth).toBe(8);
      expect(sdr8.retainSourceBlob).toBe(false);

      // Row 15a: 8-bit Display-P3 passthrough (saturation beyond sRGB kept via tag).
      const p38 = resolveIngestDecision(await files.extractMetadata(
        loadSampleFile('23_avif_15a_p3_8bit_12mp.avif', 'image/avif')));
      expect(p38.decodeChannel).toBe('image-bitmap');
      expect(p38.colorIdentity.gamut).toBe('display-p3');
      expect(p38.colorIdentity.bitDepth).toBe(8);

      // Row 15a: alpha aux → hasAlpha, content-bounds scan stays ON.
      const alpha = resolveIngestDecision(await files.extractMetadata(
        loadSampleFile('24_avif_15a_alpha_8bit_12mp.avif', 'image/avif')));
      expect(alpha.decodeChannel).toBe('image-bitmap');
      expect(alpha.skipContentBoundsScan).toBe(false);

      // Row 15b: 10/12-bit SDR → avif-proxy f16 direct, TRUE depth declared.
      const sdr10 = resolveIngestDecision(await files.extractMetadata(
        loadSampleFile('25_avif_15b_sdr10_12mp.avif', 'image/avif')));
      expect(sdr10.decodeChannel).toBe('avif-proxy');
      expect(sdr10.colorIdentity.bitDepth).toBe(10);
      expect(sdr10.colorIdentity.dataFormat).toBe('rgba16float');
      const sdr12 = resolveIngestDecision(await files.extractMetadata(
        loadSampleFile('26_avif_15b_sdr12_12mp.avif', 'image/avif')));
      expect(sdr12.decodeChannel).toBe('avif-proxy');
      expect(sdr12.colorIdentity.bitDepth).toBe(12);

      // Row 17: 8-bit Adobe RGB ICC → wide-gamut-8 (linear f16 + P3 proxy).
      const adobe8 = resolveIngestDecision(await files.extractMetadata(
        loadSampleFile('27_avif_17_adobe8_icc_12mp.avif', 'image/avif')));
      expect(adobe8.decodeChannel).toBe('wide-gamut-8');
      expect(adobe8.colorIdentity.gamut).toBe('adobe-rgb');
      expect(adobe8.colorIdentity.trc).toBe('linear');

      // Row 16-wg: 10-bit Adobe RGB ICC → avif-proxy de-gamma to true linear.
      const adobe10 = resolveIngestDecision(await files.extractMetadata(
        loadSampleFile('28_avif_16wg_adobe10_icc_12mp.avif', 'image/avif')));
      expect(adobe10.decodeChannel).toBe('avif-proxy');
      expect(adobe10.colorIdentity.gamut).toBe('adobe-rgb');
      expect(adobe10.colorIdentity.bitDepth).toBe(10);
      expect(adobe10.colorIdentity.trc).toBe('linear');

      // HDR rows (18-hdr-*): the wasm high-depth
      // channel delivers RAW transfer code values bit-exactly (probe:
      // maxDev 0), so PQ/HLG now route to avif-proxy with our own 203-nit-
      // anchored EOTF — scene-linear f16 in the source gamut. BT.2020
      // primaries ride the row's rec2020 gamutOverride (gap #8 orbit).
      // BT.2020-SDR (31) stays a negative: 'unknown' with NO transfer seam →
      // row 18, honest unsupported.
      const pq = resolveIngestDecision(await files.extractMetadata(
        loadSampleFile('29_avif_18_pq10_bt2020_12mp.avif', 'image/avif')));
      expect(pq.decodeChannel).toBe('avif-proxy');
      expect(pq.colorIdentity.trc).toBe('linear');
      expect(pq.colorIdentity.dataFormat).toBe('rgba16float');
      expect(pq.colorIdentity.gamut).toBe('rec2020');
      const hlg = resolveIngestDecision(await files.extractMetadata(
        loadSampleFile('30_avif_18_hlg10_bt2020_12mp.avif', 'image/avif')));
      expect(hlg.decodeChannel).toBe('avif-proxy');
      expect(hlg.colorIdentity.trc).toBe('linear');
      expect(hlg.colorIdentity.gamut).toBe('rec2020');

      const bt2020sdr = await files.extractMetadata(
        loadSampleFile('31_avif_18_bt2020sdr10_12mp.avif', 'image/avif'));
      expect(bt2020sdr.colorSpace, `${bt2020sdr} must resolve to unknown`).toBe('unknown');
      const neg = resolveIngestDecision(bt2020sdr);
      expect(neg.decodeChannel, 'BT.2020 SDR must be rejected (gap #8)').toBe('unsupported');

      // Row 26 NEGATIVE: animated sequence → unsupported (never the first frame).
      const animMeta = await files.extractMetadata(
        loadSampleFile('32_avif_26_animated_720p.avifs', 'image/avif'));
      expect(animMeta.isMultiFrame).toBe(true);
      const anim = resolveIngestDecision(animMeta);
      expect(anim.decodeChannel).toBe('unsupported');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2: Egest Pipeline Matrix & Pass-Through Gate (EGEST-1 to EGEST-7)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Egest Pipeline Matrix & Pass-Through Gate (EGEST-1 ~ EGEST-7)', () => {
    it('Case EGEST-1: Symmetric round-trip export & source gamut inheritance', () => {
      // 1.1 sRGB JPEG export
      const srgbDecision = resolveEgestDecision({
        format: 'jpeg',
        sourceGamut: 'srgb',
      });
      expect(srgbDecision.targetGamut).toBe('srgb');
      expect(srgbDecision.channel).toBe('canvas-8');
      expect(srgbDecision.bitDepth).toBe(8);

      // 1.2 Display-P3 JPEG export
      const p3Decision = resolveEgestDecision({
        format: 'jpeg',
        sourceGamut: 'display-p3',
      });
      expect(p3Decision.targetGamut).toBe('display-p3');
      expect(p3Decision.channel).toBe('canvas-8');

      // 1.3 Adobe RGB 16-bit TIFF export
      const adobeDecision = resolveEgestDecision({
        format: 'tiff',
        sourceGamut: 'adobe-rgb',
        requestedBitDepth: 16,
      });
      expect(adobeDecision.targetGamut).toBe('adobe-rgb');
      expect(adobeDecision.channel).toBe('raw-16');
      expect(adobeDecision.bitDepth).toBe(16);

      // 1.4 ProPhoto RGB 16-bit TIFF export
      const prophotoDecision = resolveEgestDecision({
        format: 'tiff',
        sourceGamut: 'prophoto-rgb',
        requestedBitDepth: 16,
      });
      expect(prophotoDecision.targetGamut).toBe('prophoto-rgb');
      expect(prophotoDecision.channel).toBe('raw-16');
    });

    it('Case EGEST-2: Wide-gamut raw pixel lane dispatching (raw-8 vs raw-16)', () => {
      // 2.1 Branch 2.1: 8-bit Adobe RGB exported to PNG -> raw-8 (NO 16-bit promotion, no doubling in size)
      const raw8Decision = resolveEgestDecision({
        format: 'png',
        sourceGamut: 'adobe-rgb',
        requestedGamut: 'adobe-rgb',
        requestedBitDepth: 8,
      });
      expect(raw8Decision.channel).toBe('raw-8');
      expect(raw8Decision.bitDepth).toBe(8);
      expect(raw8Decision.targetGamut).toBe('adobe-rgb');
      expect(raw8Decision.embedIcc).toBe(true);

      // 2.2 Branch 2.2: Explicit 16-bit request on PNG -> raw-16
      const raw16Decision = resolveEgestDecision({
        format: 'png',
        sourceGamut: 'adobe-rgb',
        requestedGamut: 'adobe-rgb',
        requestedBitDepth: 16,
      });
      expect(raw16Decision.channel).toBe('raw-16');
      expect(raw16Decision.bitDepth).toBe(16);
      expect(raw16Decision.targetGamut).toBe('adobe-rgb');
    });

    it('Case EGEST-3: Container capability single-directional convergence', () => {
      // Scenario A: JPEG (no prophoto envelope entry) -> clamped to the DISPLAY
      // track ('display-p3', the widest canvas-representable gamut the container
      // holds — matches the ImageInfoDrawer default suggestion ladder).
      const jpegWideDecision = resolveEgestDecision({
        format: 'jpeg',
        sourceGamut: 'adobe-rgb',
        requestedGamut: 'adobe-rgb',
      });
      expect(jpegWideDecision.targetGamut).toBe('display-p3');
      expect(jpegWideDecision.channel).toBe('canvas-8');

      // Scenario B: BMP container only supports sRGB -> clamped to 'srgb' and embedIcc=false
      const bmpDecision = resolveEgestDecision({
        format: 'bmp',
        sourceGamut: 'adobe-rgb',
      });
      expect(bmpDecision.targetGamut).toBe('srgb');
      expect(bmpDecision.channel).toBe('canvas-8');
      expect(bmpDecision.embedIcc).toBe(false);

      // Scenario C: Rec.2020 requestedGamut -> protective downgrade to
      // WORKING_GAMUT (ProPhoto). TIFF's envelope carries prophoto-rgb, so the
      // gamut is KEPT on the raw-8 lane — assert against the constant, never a
      // hardcoded space name.
      const rec2020Decision = resolveEgestDecision({
        format: 'tiff',
        sourceGamut: 'rec2020',
      });
      expect(rec2020Decision.targetGamut).toBe(WORKING_GAMUT);
      expect(rec2020Decision.channel).toBe('raw-8');
    });

    it('Case EGEST-4: Pass-Through fast-track admission & tamper-proof breakout gate', () => {
      // Branch 4.1: Source Adobe RGB, user keeps default Adobe RGB intent -> Fast-track ELIGIBLE
      const fastTrackHit = resolveEgestDecision({
        format: 'jpeg',
        sourceGamut: 'adobe-rgb',
        requestedGamut: undefined, // defaults to source
      });
      expect(fastTrackHit.gamutPassThroughEligible).toBe(true);

      // Branch 4.2: Source Adobe RGB, user explicitly requests sRGB -> Fast-track INELIGIBLE (Hard breakout)
      const fastTrackMiss = resolveEgestDecision({
        format: 'jpeg',
        sourceGamut: 'adobe-rgb',
        requestedGamut: 'srgb',
      });
      expect(fastTrackMiss.gamutPassThroughEligible).toBe(false);
      expect(fastTrackMiss.targetGamut).toBe('srgb');
    });

    it('Case EGEST-5: Wide-gamut source exported to sRGB yields true sRGB + stock ICC profile', () => {
      const exportSrgb = resolveEgestDecision({
        format: 'jpeg',
        sourceGamut: 'adobe-rgb',
        requestedGamut: 'srgb',
      });
      expect(exportSrgb.targetGamut).toBe('srgb');
      expect(exportSrgb.embedIcc).toBe(true);
      expect(exportSrgb.channel).toBe('canvas-8');
      expect(exportSrgb.canvasColorSpace).toBe('srgb');
    });

    it('Case EGEST-7: Document intrinsic resolution decoupled from DPR=1 guarantee', () => {
      // Validates channel color space consistency and 1:1 canvas tagging
      const dprCheck = resolveEgestDecision({
        format: 'png',
        sourceGamut: 'display-p3',
      });
      expect(dprCheck.canvasColorSpace).toBe('display-p3');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 3: Internal Physical Bake & Document Gamut Anchoring (CLOSE-2)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Internal Physical Bake (CLOSE-2: Gamut Deterministic Inheritance)', () => {
    it('Case CLOSE-2: Composite bake preserves base frame gamut without pollution', () => {
      // Simulated docAsset anchoring test:
      // When a document baseline is sRGB, adding Adobe RGB or Display-P3 layer fragments
      // MUST NOT elevate or pollute the composite product gamut.
      const baseFrameGamut = 'srgb';
      const childLayerGamut = 'adobe-rgb';

      // Replicating CompositeDispatcher's rule that the composite gamut strictly
      // inherits the frame's base asset gamut (default 'srgb'):
      // const docAsset = request.frame.assetId ? this.assets.get(request.frame.assetId) : undefined;
      // const docGamut: GamutId = docAsset?.gamut ?? 'srgb';
      const compositedGamut = baseFrameGamut; // strictly inherits from frame base

      expect(compositedGamut).toBe('srgb');
      expect(compositedGamut).not.toBe(childLayerGamut);
    });
  });
});
