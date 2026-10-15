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
 * 'webcodecs-heic' channel (rule 19a) — the main-thread half of the
 * hardware decode pipeline.
 *
 * Flow: the already-parsed {@link HeicFileView} (extractPayload: true) is
 * shipped to the shared HEIC worker, which runs VideoDecoder per tile
 * (length-prefixed NALs verbatim + hvcC description), converts NV12/I420 →
 * RGBA-8 with fixed-point YUV→RGB, and composes the grid with the orientation
 * applied during placement. The main thread then produces the gamut-tagged PNG
 * proxy — identical tail to the libheif proxy channel.
 *
 * Fail-Fast: any worker error propagates as a thrown Error — rule 19a passed
 * the decision-time capability gate, so reaching a decode failure means the
 * probe disagreed with the real decoder and MUST surface, never silently fall
 * back to the proxy.
 *
 * @module core/files/handlers/heic/harddecode
 */

import type { HeicFileView } from './metadata/container';
import type { GamutId } from '@opengpex/editor/core/types';
import { buildGamutProxy, heicWorkerCall } from './transcode';

/** Worker reply for one hard decode (timings for perf-budget checks). */
export interface HeicHardDecodeOut {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  timings?: { yuvMs: number; composeMs: number; totalMs: number };
}

/**
 * Run the hardware decode for a parsed HEIC view and produce the uprighted
 * RGBA-8 pixels.
 *
 * @param view        - container view parsed with `extractPayload: true`
 * @param matrix      - YUV matrix from the container colour signal
 *                      ('2020' when nclx matrix_coefficients = 9, else '709' —
 *                      P3 SDR sources are BT.709-quantized)
 * @param fullRange   - nclx full_range_flag (Apple files: false)
 */
export async function decodeHeicHard(
  view: HeicFileView,
  matrix: '709' | '2020',
  fullRange: boolean,
): Promise<HeicHardDecodeOut> {
  // The container parser hands out subarray VIEWS into the original file
  // buffer (description + every tile share one ArrayBuffer) — postMessage
  // rejects transferring the same buffer twice, so ship standalone copies.
  const description = view.primary.hvcCDescription.slice();
  const tiles = view.primary.tiles.map((t) => ({
    data: t.nalData.slice(),
    gridRow: t.gridRow,
    gridCol: t.gridCol,
  }));
  const payload = {
    codec: view.primary.codecString,
    description,
    tiles,
    grid: view.primary.grid
      ? {
          rows: view.primary.grid.rows,
          cols: view.primary.grid.cols,
          outputWidth: view.primary.grid.outputWidth,
          outputHeight: view.primary.grid.outputHeight,
        }
      : undefined,
    codedWidth: view.primary.codedWidth,
    codedHeight: view.primary.codedHeight,
    orientation: view.orientation,
    matrix,
    fullRange,
  };

  const transfer: ArrayBuffer[] = [description.buffer as ArrayBuffer];
  for (const t of tiles) {
    transfer.push(t.data.buffer as ArrayBuffer);
  }

  return heicWorkerCall<HeicHardDecodeOut>('decodeHard', [payload], transfer);
}

/** Convenience: hard decode + gamut-tagged PNG proxy in one call. */
export async function decodeHeicHardToProxy(
  view: HeicFileView,
  gamut: GamutId,
  matrix: '709' | '2020',
  fullRange: boolean,
): Promise<{ displayBlob: Blob; width: number; height: number }> {
  const { rgba, width, height } = await decodeHeicHard(view, matrix, fullRange);
  return buildGamutProxy(rgba, width, height, gamut);
}
