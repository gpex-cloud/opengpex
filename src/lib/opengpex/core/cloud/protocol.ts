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

// ─── Auth ─────────────────────────────────────────────────────────────────────

/** GET - Get current session/user info */
export const API_AUTH_SESSION = "/api/auth/session";

/** POST - Send OTP to email */
export const API_AUTH_LOGIN = "/api/auth/login";

/** POST - Verify OTP code */
export const API_AUTH_VERIFY_OTP = "/api/auth/verify-otp";

/** POST - Resend OTP code */
export const API_AUTH_RESEND = "/api/auth/resend";

/** POST - Refresh access token using refresh token */
export const API_AUTH_REFRESH = "/api/auth/refresh";

/** POST - Sign out (invalidate session) */
export const API_AUTH_LOGOUT = "/api/auth/logout";

/** POST - Exchange popup OAuth one-time code for tokens */
export const API_AUTH_EXCHANGE_CODE = "/api/auth/exchange-code";

/** POST (generate) / PUT (redeem) - SSO code for cross-site login sync */
export const API_AUTH_SSO_CODE = "/api/auth/sso-code";

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
