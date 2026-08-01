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
 * MurmurHash3 x86 128-bit — public domain, zero dependencies.
 * Processes 16 bytes per iteration (4x 32-bit lanes), producing a 128-bit hash.
 * Passes all SMHasher tests. Suitable for content-addressable storage,
 * asset deduplication, and any non-cryptographic hashing needs.
 *
 * @param data - Input bytes to hash
 * @param seed - Optional seed value (default 0)
 * @returns 32-character hex string (128-bit)
 */
export function murmurHash3_x86_128(data: Uint8Array, seed = 0): string {
  const len = data.length;
  const nblocks = len >>> 4; // 16 bytes per block

  let h1 = seed >>> 0;
  let h2 = seed >>> 0;
  let h3 = seed >>> 0;
  let h4 = seed >>> 0;

  const c1 = 0x239b961b;
  const c2 = 0xab0e9789;
  const c3 = 0x38b34ae5;
  const c4 = 0xa1e38b93;

  // Body: process 16-byte blocks
  for (let i = 0; i < nblocks; i++) {
    const off = i * 16;
    let k1 = (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
    let k2 = (data[off + 4] | (data[off + 5] << 8) | (data[off + 6] << 16) | (data[off + 7] << 24)) >>> 0;
    let k3 = (data[off + 8] | (data[off + 9] << 8) | (data[off + 10] << 16) | (data[off + 11] << 24)) >>> 0;
    let k4 = (data[off + 12] | (data[off + 13] << 8) | (data[off + 14] << 16) | (data[off + 15] << 24)) >>> 0;

    k1 = Math.imul(k1, c1) >>> 0; k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0; k1 = Math.imul(k1, c2) >>> 0;
    h1 ^= k1; h1 = ((h1 << 19) | (h1 >>> 13)) >>> 0; h1 = (h1 + h2) >>> 0; h1 = (Math.imul(h1, 5) + 0x561ccd1b) >>> 0;

    k2 = Math.imul(k2, c2) >>> 0; k2 = ((k2 << 16) | (k2 >>> 16)) >>> 0; k2 = Math.imul(k2, c3) >>> 0;
    h2 ^= k2; h2 = ((h2 << 17) | (h2 >>> 15)) >>> 0; h2 = (h2 + h3) >>> 0; h2 = (Math.imul(h2, 5) + 0x0bcaa747) >>> 0;

    k3 = Math.imul(k3, c3) >>> 0; k3 = ((k3 << 17) | (k3 >>> 15)) >>> 0; k3 = Math.imul(k3, c4) >>> 0;
    h3 ^= k3; h3 = ((h3 << 15) | (h3 >>> 17)) >>> 0; h3 = (h3 + h4) >>> 0; h3 = (Math.imul(h3, 5) + 0x96cd1c35) >>> 0;

    k4 = Math.imul(k4, c4) >>> 0; k4 = ((k4 << 18) | (k4 >>> 14)) >>> 0; k4 = Math.imul(k4, c1) >>> 0;
    h4 ^= k4; h4 = ((h4 << 13) | (h4 >>> 19)) >>> 0; h4 = (h4 + h1) >>> 0; h4 = (Math.imul(h4, 5) + 0x32ac3b17) >>> 0;
  }

  // Tail: remaining bytes
  const tail = nblocks * 16;
  let k1 = 0, k2 = 0, k3 = 0, k4 = 0;
  const rem = len & 15;
  if (rem >= 15) k4 ^= data[tail + 14] << 16;
  if (rem >= 14) k4 ^= data[tail + 13] << 8;
  if (rem >= 13) { k4 ^= data[tail + 12]; k4 = Math.imul(k4, c4) >>> 0; k4 = ((k4 << 18) | (k4 >>> 14)) >>> 0; k4 = Math.imul(k4, c1) >>> 0; h4 ^= k4; }
  if (rem >= 12) k3 ^= data[tail + 11] << 24;
  if (rem >= 11) k3 ^= data[tail + 10] << 16;
  if (rem >= 10) k3 ^= data[tail + 9] << 8;
  if (rem >= 9) { k3 ^= data[tail + 8]; k3 = Math.imul(k3, c3) >>> 0; k3 = ((k3 << 17) | (k3 >>> 15)) >>> 0; k3 = Math.imul(k3, c4) >>> 0; h3 ^= k3; }
  if (rem >= 8) k2 ^= data[tail + 7] << 24;
  if (rem >= 7) k2 ^= data[tail + 6] << 16;
  if (rem >= 6) k2 ^= data[tail + 5] << 8;
  if (rem >= 5) { k2 ^= data[tail + 4]; k2 = Math.imul(k2, c2) >>> 0; k2 = ((k2 << 16) | (k2 >>> 16)) >>> 0; k2 = Math.imul(k2, c3) >>> 0; h2 ^= k2; }
  if (rem >= 4) k1 ^= data[tail + 3] << 24;
  if (rem >= 3) k1 ^= data[tail + 2] << 16;
  if (rem >= 2) k1 ^= data[tail + 1] << 8;
  if (rem >= 1) { k1 ^= data[tail]; k1 = Math.imul(k1, c1) >>> 0; k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0; k1 = Math.imul(k1, c2) >>> 0; h1 ^= k1; }

  // Finalization: mix length and fmix
  h1 ^= len; h2 ^= len; h3 ^= len; h4 ^= len;
  h1 = (h1 + h2) >>> 0; h1 = (h1 + h3) >>> 0; h1 = (h1 + h4) >>> 0;
  h2 = (h2 + h1) >>> 0; h3 = (h3 + h1) >>> 0; h4 = (h4 + h1) >>> 0;

  // fmix32
  h1 ^= h1 >>> 16; h1 = Math.imul(h1, 0x85ebca6b) >>> 0; h1 ^= h1 >>> 13; h1 = Math.imul(h1, 0xc2b2ae35) >>> 0; h1 ^= h1 >>> 16;
  h2 ^= h2 >>> 16; h2 = Math.imul(h2, 0x85ebca6b) >>> 0; h2 ^= h2 >>> 13; h2 = Math.imul(h2, 0xc2b2ae35) >>> 0; h2 ^= h2 >>> 16;
  h3 ^= h3 >>> 16; h3 = Math.imul(h3, 0x85ebca6b) >>> 0; h3 ^= h3 >>> 13; h3 = Math.imul(h3, 0xc2b2ae35) >>> 0; h3 ^= h3 >>> 16;
  h4 ^= h4 >>> 16; h4 = Math.imul(h4, 0x85ebca6b) >>> 0; h4 ^= h4 >>> 13; h4 = Math.imul(h4, 0xc2b2ae35) >>> 0; h4 ^= h4 >>> 16;

  h1 = (h1 + h2) >>> 0; h1 = (h1 + h3) >>> 0; h1 = (h1 + h4) >>> 0;
  h2 = (h2 + h1) >>> 0; h3 = (h3 + h1) >>> 0; h4 = (h4 + h1) >>> 0;

  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') +
         h3.toString(16).padStart(8, '0') + h4.toString(16).padStart(8, '0');
}

/**
 * Compute content hash of binary data for asset deduplication.
 *
 * - Secure context (HTTPS / localhost): SHA-256 via native Web Crypto API
 *   (hardware-accelerated, ~5-20ms for 10MB).
 * - Non-secure context (HTTP over LAN): MurmurHash3-128 pure JS
 *   (~50ms for 10MB, 128-bit, excellent distribution).
 *
 * @param blob - Binary data to hash
 * @returns Hex string hash (64 chars for SHA-256, 32 chars for MurmurHash3)
 */
export async function calculateContentHash(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();

  // crypto.subtle is only available in secure contexts (HTTPS / localhost)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback: MurmurHash3 x86 128-bit (pure JS, no dependencies)
  return murmurHash3_x86_128(new Uint8Array(buffer));
}
