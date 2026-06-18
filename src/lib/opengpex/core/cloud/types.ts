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

"use client";

/**
 * CloudMenu / cloud-sdk / types
 *
 * Public type definitions for the cloud SDK.
 * These types define the contract between the CloudMenu plugin and GPEX Cloud.
 */



import type { GpexManifest } from "@opengpex/editor/core/helpers/gpex-format";

export interface GpexQuota {
  usedBytes: number;
  totalBytes: number;
  fileCount: number;
}

/** A file record returned by the list API */
export interface GpexFileItem {
  fileId: string;
  fileLocalId: string;
  manifest: GpexManifest;
  previewB64: string | null;
  fileSize: number;
  fingerprint: string | null;
  version: number;
  updatedAt: string;
}

/** Result returned after saving a file */
export interface GpexFileSaveResult {
  fileId: string;
  version: number;
  fingerprint: string;
  savedAt: string;
}



/** Result returned after creating a share link */
export interface GpexShareResult {
  shareToken: string;
  shareUrl: string;
  createdAt: string;
}

export interface GpexCloudProviderProps {
  /** Override the default API endpoint (defaults to https://gpex.cloud) */
  apiBaseUrl?: string;
  children: import("react").ReactNode;
}
