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
 * cloud-sdk / auth / http-client
 *
 * Fetch wrapper that automatically attaches Bearer token and
 * handles automatic token refresh on 401.
 *
 * Always operates in cross-origin mode (opengpex ≠ gpex-cloud domain).
 */

import { getAccessToken, setAccessToken, getRefreshToken, setRefreshToken, clearTokens } from "./token-store";
import { API_AUTH_REFRESH } from "../protocol";

export interface HttpClientConfig {
  apiBaseUrl: string;
  onSessionExpired?: () => void;
}

let clientConfig: HttpClientConfig | null = null;

export function initHttpClient(config: HttpClientConfig): void {
  clientConfig = config;
}

// ─── Token Refresh (deduplicated) ─────────────────────────────────────────────

let refreshPromise: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!clientConfig) return false;

  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${clientConfig.apiBaseUrl}${API_AUTH_REFRESH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) return false;

      const data = await res.json() as { accessToken?: string; refreshToken?: string };
      if (data.accessToken) setAccessToken(data.accessToken);
      if (data.refreshToken) setRefreshToken(data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ─── Authenticated Fetch ──────────────────────────────────────────────────────

async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  if (!clientConfig) throw new Error("HTTP client not initialized. Call initHttpClient() first.");

  const url = `${clientConfig.apiBaseUrl}${path}`;

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };

  const token = getAccessToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const fetchOptions: RequestInit = { ...options, headers };

  let response = await fetch(url, fetchOptions);

  // Auto-refresh on 401
  if (response.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) {
      const newToken = getAccessToken();
      if (newToken) headers["Authorization"] = `Bearer ${newToken}`;
      response = await fetch(url, { ...fetchOptions, headers });
    } else {
      clearTokens();
      clientConfig.onSessionExpired?.();
    }
  }

  return response;
}

export { authFetch };
