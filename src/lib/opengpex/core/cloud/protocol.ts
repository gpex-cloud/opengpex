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
 * CloudMenu / cloud-sdk / protocol
 *
 * API endpoint constants for GPEX Cloud.
 * Centralized here so changes only need to happen in one place.
 */

// ─── User Files ───────────────────────────────────────────────────────────────

/** POST - Upload/overwrite a .gpex file (multipart, file only) */
export const API_FILES_SAVE = "/api/user/files/save";

/** GET - List all user files (returns { files: GpexFileItem[] }) */
export const API_FILES_LIST = "/api/user/files/list";

/** GET - Download file binary; DELETE - Remove file. Append /:id */
export const API_FILES_BY_ID = "/api/user/files";

// ─── Sharing ──────────────────────────────────────────────────────────────────

/** POST - Create share link; DELETE - Revoke share link. Append /:id/share */
export const API_FILES_SHARE = "/api/user/files";

// ─── Quota ────────────────────────────────────────────────────────────────────

/** GET - Get user storage quota */
export const API_QUOTA = "/api/user/quota";
