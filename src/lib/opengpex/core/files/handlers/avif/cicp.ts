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
 * In-place nclx CICP patch for jsquash-encoded AVIF output.
 *
 * WHY IN-PLACE OVERWRITE (and not a box insert)
 * ---------------------------------------------
 * The @jsquash encoder already writes a `colr` box with an `nclx` payload into
 * `meta/iprp/ipco` on EVERY encode (probe B7: 470-byte output, `colr size=19`
 * = 8-byte header + 4-byte 'nclx' type + three u16 CICP values + full_range
 * flag). The HDR lane's only metadata need is different CICP *values* (e.g.
 * 9/16/9 for BT.2020 primaries + PQ), so the patch is three u16 overwrites at
 * fixed offsets — byte length unchanged, no iloc/mdat offset shifts, no ipma
 * association bookkeeping. A missing-colr insert would require all of that,
 * and a PQ file WITHOUT a transfer marker is worse than a failed export: every
 * consumer would misread it as SDR. Hence the loud throw below.
 *
 * THE PAYLOAD LAYOUT (ISO/IEC 14496-12 §12.1.5 `ColourInformationBox`):
 *   [0..3]  colour_type = 'nclx'   (4 bytes, checked, never written)
 *   [4..5]  colour_primaries        u16 BE  ← overwritten
 *   [6..7]  transfer_characteristics u16 BE ← overwritten
 *   [8..9]  matrix_coefficients     u16 BE  ← overwritten
 *   [10]    full_range_flag         u8      (kept as the encoder wrote it)
 */

export interface NclxCicp {
  /** ITU-T H.273 colour primaries code (BT.2020 = 9). */
  readonly colourPrimaries: number;
  /** ITU-T H.273 transfer characteristics code (PQ = 16). */
  readonly transferCharacteristics: number;
  /** ITU-T H.273 matrix coefficients code (BT.2020 non-constant luminance = 9). */
  readonly matrixCoefficients: number;
}

/** The single descendant path jsquash writes: meta → iprp → ipco → colr. */
const DESCEND_BOXES = new Set(['meta', 'iprp', 'ipco']);

/**
 * Overwrite the `nclx` CICP values of the `colr` box inside an AVIF (ISOBMFF)
 * byte stream, in place.
 *
 * Box walk: top-level boxes from 0; inside `meta` children start after the
 * 4-byte version/flags (meta is a FullBox); `iprp`/`ipco` are plain boxes.
 * The FIRST `colr` box found under `ipco` is patched (jsquash writes exactly
 * one; multiple colr boxes are out of spec for this writer).
 *
 * @throws if no `colr` box exists under `ipco`, or the box found is not an
 *         11-byte `nclx` payload — see the module note for why this fails
 *         loudly instead of degrading.
 */
export function patchNclxCicp(bytes: Uint8Array, cicp: NclxCicp): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const boxType = (pos: number): string =>
    String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);

  // Yields (type, dataStart, dataEnd) for the boxes in [start, end).
  function* iterateBoxes(start: number, end: number): Generator<[string, number, number]> {
    let pos = start;
    while (pos + 8 <= end) {
      const size = view.getUint32(pos);
      const type = boxType(pos);
      if (size < 8 || pos + size > end) return; // malformed — stop walking
      yield [type, pos + 8, pos + size];
      pos += size;
    }
  }

  function findColr(start: number, end: number): number {
    for (const [type, dataStart, dataEnd] of iterateBoxes(start, end)) {
      if (type === 'colr') return dataStart;
      if (DESCEND_BOXES.has(type)) {
        // `meta` is a FullBox: its children begin after the 4 version/flags bytes.
        const innerStart = type === 'meta' ? dataStart + 4 : dataStart;
        const hit = findColr(innerStart, dataEnd);
        if (hit >= 0) return hit;
      }
    }
    return -1;
  }

  const colrPayload = findColr(0, bytes.length);
  if (colrPayload < 0) {
    throw new Error(
      '[cicp] no colr box found under meta/iprp/ipco — the encoder output is not patchable',
    );
  }
  const isNclx =
    bytes[colrPayload] === 0x6e && // 'n'
    bytes[colrPayload + 1] === 0x63 && // 'c'
    bytes[colrPayload + 2] === 0x6c && // 'l'
    bytes[colrPayload + 3] === 0x78; // 'x'
  if (!isNclx || colrPayload + 11 > bytes.length) {
    throw new Error('[cicp] colr box is not an nclx payload — cannot patch CICP values');
  }

  view.setUint16(colrPayload + 4, cicp.colourPrimaries);
  view.setUint16(colrPayload + 6, cicp.transferCharacteristics);
  view.setUint16(colrPayload + 8, cicp.matrixCoefficients);
}

/** The CICP triple the HDR AVIF lane ships: BT.2020 primaries, PQ, BT.2020 ncl matrix. */
export const HDR_AVIF_CICP: NclxCicp = {
  colourPrimaries: 9,
  transferCharacteristics: 16,
  matrixCoefficients: 9,
};
