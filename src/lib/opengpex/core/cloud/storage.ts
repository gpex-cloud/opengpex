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
 * CloudMenu / cloud-sdk / storage
 *
 * Cloud storage API for opengpex.
 * All methods require the user to be signed in (checked internally).
 * Uses the self-contained authenticated HTTP client.
 *
 * Upload protocol: client sends only the .gpex file.
 * Server resolves manifest, preview, and UPSERT key from file content.
 */

import { authFetch } from "./auth";
import { API_FILES_SAVE, API_FILES_LIST, API_FILES_BY_ID, API_FILES_SHARE, API_QUOTA } from "./protocol";
import type { GpexFileItem, GpexFileSaveResult, GpexQuota, GpexShareResult } from "./types";

/**
 * Save a .gpex file to GPEX Cloud.
 * The server parses the file to extract manifest, preview, and local ID.
 *
 * @param file - The .gpex file (File or Blob with name)
 * @param fileName - File name with extension (e.g. "portrait.gpex"). Used if file has no name.
 */
export async function save(file: File | Blob, fileName?: string): Promise<GpexFileSaveResult> {
  const formData = new FormData();

  if (file instanceof File) {
    formData.append("file", file);
  } else {
    // Blob doesn't have a name, so we provide one
    formData.append("file", file, fileName || "untitled.gpex");
  }

  const res = await authFetch(API_FILES_SAVE, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Save failed" }));
    throw new Error((err as { error?: string }).error || "Save failed");
  }

  return res.json() as Promise<GpexFileSaveResult>;
}

/**
 * List all saved files from GPEX Cloud.
 * Returns items with manifest metadata and inline preview (base64).
 */
export async function list(): Promise<GpexFileItem[]> {
  const res = await authFetch(API_FILES_LIST, {
    method: "GET",
  });

  if (!res.ok) {
    throw new Error("Failed to list files");
  }

  const data: { files: GpexFileItem[] } = await res.json();
  return data.files || [];
}

/**
 * Download a .gpex file from GPEX Cloud.
 *
 * @param fileId - The cloud file ID
 * @returns ArrayBuffer of the .gpex file content
 */
export async function download(fileId: string): Promise<ArrayBuffer> {
  const res = await authFetch(`${API_FILES_BY_ID}/${fileId}`, {
    method: "GET",
  });

  if (!res.ok) {
    throw new Error("Download failed");
  }

  return res.arrayBuffer();
}

/**
 * Delete a file from GPEX Cloud.
 *
 * @param fileId - The cloud file ID
 */
export async function remove(fileId: string): Promise<void> {
  const res = await authFetch(`${API_FILES_BY_ID}/${fileId}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Delete failed" }));
    throw new Error((err as { error?: string }).error || "Delete failed");
  }
}

/**
 * Get the user's storage quota.
 */
export async function getQuota(): Promise<GpexQuota> {
  const res = await authFetch(API_QUOTA, {
    method: "GET",
  });

  if (!res.ok) {
    throw new Error("Failed to get quota");
  }

  return res.json() as Promise<GpexQuota>;
}

/**
 * Create a share link for a cloud file (idempotent).
 * If the file already has an active share, returns the existing link.
 *
 * @param fileId - The cloud file ID
 * @returns Share token and full share URL
 */
export async function share(fileId: string): Promise<GpexShareResult> {
  const res = await authFetch(`${API_FILES_SHARE}/${fileId}/share`, {
    method: "POST",
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Share failed" }));
    throw new Error((err as { error?: string }).error || "Share failed");
  }

  return res.json() as Promise<GpexShareResult>;
}

/**
 * Revoke (deactivate) the share link for a cloud file.
 *
 * @param fileId - The cloud file ID
 */
export async function unshare(fileId: string): Promise<void> {
  const res = await authFetch(`${API_FILES_SHARE}/${fileId}/share`, {
    method: "DELETE",
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Unshare failed" }));
    throw new Error((err as { error?: string }).error || "Unshare failed");
  }
}

/** Namespace-style export for convenient usage */
export const gpexStorage = {
  save,
  list,
  download,
  remove,
  getQuota,
  share,
  unshare,
};
