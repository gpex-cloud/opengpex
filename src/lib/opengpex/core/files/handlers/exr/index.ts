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
 * EXR format handler — HDR scene-referred EXPORT only.
 *
 * ENCODE: the container wraps half-float LINEAR light; the dispatcher's
 * 'exr-half' lane has already un-premultiplied + gamut-converted the GPU
 * readback into half BIT PATTERNS (`unpremultiplyEncodeLinearF16` — unclamped
 * RGB, the scene-referred contract), so this handler does zero colour math:
 * container assembly (see encode.ts for the probe-pinned format facts) + the
 * `chromaticities` attribute matching the SAME targetGamut the matrix used.
 * ICC is not embedded (EXR colour travels via chromaticities, not profiles).
 *
 * DECODE: unsupported — there is no EXR decoder in the system, and the ingest
 * decision table routes 'exr' to the honest unsupported terminus (row 26).
 * A future EXR ingest must re-probe decoder options first (standing finding:
 * ffmpeg 9.0.2's exr-half numeric path is untrustworthy).
 */

import type {
  ImageFormatHandler,
  DecodeOptions,
  DecodedPayload,
  EncodeOptions,
} from '../../types';
import type { ImageMetadata } from '../../types';
import type { IngestDecision } from '../../strategy';
import { isRawPixelSource } from '../../types';
import { encodeExrHalf, encodeExrHalfZip } from './encode';

export class ExrHandler implements ImageFormatHandler {
  readonly format = 'exr';
  readonly mimeTypes = ['image/x-exr', 'image/exr', 'application/x-exr'];
  readonly extensions = ['exr'];

  async decode(
    file: File,
    _metadata: ImageMetadata,
    _decision: IngestDecision,
    _options?: DecodeOptions,
  ): Promise<DecodedPayload[]> {
    // Honest terminus: no EXR decoder exists (Fail-Fast, never a fake 8-bit path).
    throw new Error(
      `[exr] decode unsupported: OpenEXR ingest is not implemented (export-only container) — "${file.name}"`,
    );
  }

  /** No metadata extractor: EXR is export-only (ingest is the honest terminus). */
  async extractMetadata(_file: File): Promise<ImageMetadata> {
    throw new Error('[exr] metadata extraction unsupported: OpenEXR ingest is not implemented');
  }

  async encode(source: unknown, options: EncodeOptions): Promise<Blob> {
    if (!isRawPixelSource(source)) {
      throw new Error('[exr] encode requires a RawPixelSource (the exr-half lane deliverable)');
    }
    if (source.bitDepth !== 16 || !(source.data instanceof Uint16Array)) {
      throw new Error('[exr] encode requires 16-bit half-float BIT PATTERNS (Uint16Array)');
    }
    const gamut = (options.exportConfig?.targetGamut as string | undefined)
      ?? (source.colorSpace as string | undefined);
    // ZIP (per-scanline predictor + zlib) is the default lane; the
    // uncompressed writer stays reachable for byte-comparison diagnostics.
    const compression = (options.exportConfig?.exrCompression as string | undefined) ?? 'zip';
    const bytes = compression === 'none'
      ? encodeExrHalf(source.data, source.width, source.height, gamut)
      : await encodeExrHalfZip(source.data, source.width, source.height, gamut);
    return new Blob([bytes as BlobPart], { type: 'image/x-exr' });
  }
}
