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
 * cloud-sdk / auth
 *
 * Self-contained client-side auth SDK for GPEX Cloud.
 * No external dependencies on gpex-cloud source code.
 * Communicates with gpex-cloud server via HTTP only.
 */

export { AuthProvider } from "./provider";
export { useAuth } from "./hooks";
export { authFetch, initHttpClient } from "./http-client";
export { popupOAuth } from "./oauth-popup";
export type { PopupOAuthConfig, PopupOAuthResult } from "./oauth-popup";
export { LoginModal } from "./ui/LoginModal";

export type {
  AuthUser,
  Branding,
  AuthState,
  AuthContextValue,
  AuthProviderProps,
} from "./types";
