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
 * Fetch wrapper that automatically attaches credentials:
 * - Same-origin: uses { credentials: 'include' } for cookie
 * - Cross-origin: attaches Authorization Bearer header
 * Handles automatic token refresh on 401.
 */

import { getAccessToken, setAccessToken, getRefreshToken, setRefreshToken, clearTokens } from "./token-store";


export interface HttpClientConfig {
  apiBaseUrl: string;
  onSessionExpired?: () => void;
}

let clientConfig: HttpClientConfig | null = null;

export function initHttpClient(config: HttpClientConfig): void {
  clientConfig = config;
}

function isSameOrigin(): boolean {
  if (!clientConfig || typeof window === "undefined") return false;
  // Empty or relative apiBaseUrl = same-origin
  if (!clientConfig.apiBaseUrl || !clientConfig.apiBaseUrl.startsWith("http")) return true;
  try {
    return new URL(clientConfig.apiBaseUrl).origin === window.location.origin;
  } catch {
    return true;
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!clientConfig) return false;

  const sameOrigin = isSameOrigin();

  // In same-origin mode, cookies are auto-sent, just call refresh
  // In cross-origin mode, send refresh token in body
  const refreshToken = sameOrigin ? undefined : getRefreshToken();
  if (!sameOrigin && !refreshToken) return false;

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${clientConfig.apiBaseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: sameOrigin ? "include" : "omit",
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) return false;

      const data = await res.json() as { accessToken?: string; refreshToken?: string };
      if (data.accessToken) {
        setAccessToken(data.accessToken);
      }
      if (data.refreshToken) {
        setRefreshToken(data.refreshToken);
      }
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  if (!clientConfig) throw new Error("HTTP client not initialized. Call initHttpClient() first.");

  const url = `${clientConfig.apiBaseUrl}${path}`;
  const sameOrigin = isSameOrigin();

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };

  if (!sameOrigin) {
    const token = getAccessToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  const fetchOptions: RequestInit = {
    ...options,
    headers,
    credentials: sameOrigin ? "include" : "omit",
  };

  let response = await fetch(url, fetchOptions);

  // Auto-refresh on 401
  if (response.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) {
      // Retry with new token
      if (!sameOrigin) {
        const newToken = getAccessToken();
        if (newToken) {
          headers["Authorization"] = `Bearer ${newToken}`;
        }
      }
      response = await fetch(url, { ...fetchOptions, headers });
    } else {
      // Session truly expired
      clearTokens();
      clientConfig.onSessionExpired?.();
    }
  }

  return response;
}



/** Raw fetch with auth (for advanced use cases) */
export { authFetch };
