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
 * Formats a byte value into a human-readable string (e.g., 1.2 MB).
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

interface EstimateParams {
  fw: number;
  fh: number;
  exportFormat: string;
  fileDetails: { size: number; type: string };
  imgDim: { w: number; h: number };
}

/**
 * Smartly estimates the file size of the processed image based on 
 * result dimensions, target format, and original image density.
 */
export function estimateFileSize({
  fw,
  fh,
  exportFormat,
  fileDetails,
  imgDim
}: EstimateParams): string {
  // Pixel Density Calculation
  const originalBPP = fileDetails.size / (imgDim.w * imgDim.h || 1);
  const isSourceLossless = fileDetails.type === 'PNG';
  const isTargetLossless = exportFormat === 'image/png';
  
  let ratio = 1;
  // Approximation ratios for format switching
  if (isSourceLossless && !isTargetLossless) {
    ratio = 0.15; // Significant reduction from PNG to lossy
  } else if (!isSourceLossless && isTargetLossless) {
    ratio = 6.0;  // Expansion from lossy to lossless PNG
  }
  
  // Enforce a minimum density to avoid 0KB estimates for small files
  const estimatedBPP = Math.max(originalBPP * ratio, isTargetLossless ? 1.0 : 0.15);
  return `~${formatBytes(fw * fh * estimatedBPP)}`;
}
/**
 * Converts a Data URL to a Blob.
 */
export async function dataURLToBlob(dataURL: string): Promise<Blob> {
  const res = await fetch(dataURL);
  return await res.blob();
}

/**
 * Converts a Blob to a Data URL.
 */
export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
