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
 * cloud-sdk / auth / oauth-popup
 *
 * Popup-based OAuth flow.
 * Opens a popup window to gpex-cloud for OAuth, receives a one-time code
 * via postMessage, then exchanges the code for tokens via HTTPS API.
 *
 * Security: Tokens never appear in URLs or postMessage — only a one-time
 * code (60s TTL, single-use) is transmitted via postMessage.
 */

import { API_AUTH_EXCHANGE_CODE } from "../protocol";

export interface PopupOAuthConfig {
  apiBaseUrl: string;
  provider: string;
}

export interface PopupOAuthResult {
  accessToken: string;
  refreshToken: string;
}

/**
 * Opens a popup window to initiate OAuth via gpex-cloud.
 * Returns a Promise that resolves with tokens on success.
 *
 * Flow:
 * 1. Popup opens gpex-cloud/auth/oauth-popup → redirects to OAuth provider
 * 2. Provider authorizes → callback → gpex-cloud generates one-time code
 * 3. Code delivery (dual-channel for COOP compatibility):
 *    a. If window.opener is available: postMessage sends code to opener
 *    b. If COOP severs opener (SharedArrayBuffer mode): gpex-cloud redirects
 *       to opengpex /auth/oauth-relay, which uses BroadcastChannel
 * 4. This function calls /api/auth/exchange-code to get tokens
 * 5. Promise resolves with { accessToken, refreshToken }
 */
export function popupOAuth(config: PopupOAuthConfig): Promise<PopupOAuthResult> {
  const { apiBaseUrl, provider } = config;
  const origin = window.location.origin;

  return new Promise((resolve, reject) => {
    const popupUrl = `${apiBaseUrl}/auth/oauth-popup?provider=${encodeURIComponent(provider)}&origin=${encodeURIComponent(origin)}`;

    // Center the popup relative to the current browser window
    const width = 500;
    const height = 650;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
    const popup = window.open(
      popupUrl,
      "gpex-oauth",
      `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`,
    );

    if (!popup) {
      reject(new Error("Popup blocked by browser. Please allow popups for this site."));
      return;
    }

    const expectedOrigin = new URL(apiBaseUrl).origin;

    // Guard flag: prevents race condition between poll timer and message handler
    let settled = false;

    const handler = async (event: MessageEvent) => {
      // Verify message origin
      if (event.origin !== expectedOrigin) return;

      const { type } = event.data || {};
      if (type !== "GPEX_OAUTH_CODE" && type !== "GPEX_OAUTH_ERROR") return;

      settled = true;
      window.removeEventListener("message", handler);
      channel.close();
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);

      // Handle error from OAuth callback
      if (type === "GPEX_OAUTH_ERROR") {
        const errorCode = event.data.error || "unknown_error";
        try { if (!popup.closed) popup.close(); } catch { /* ignore */ }
        reject(new Error(errorCode));
        return;
      }

      try {
        // Exchange one-time code for tokens via HTTPS
        const res = await fetch(`${apiBaseUrl}${API_AUTH_EXCHANGE_CODE}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: event.data.code }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          reject(new Error((errData as { error?: string }).error || "Code exchange failed"));
          return;
        }

        const tokens = (await res.json()) as PopupOAuthResult;
        resolve({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        });
      } catch (err) {
        reject(err);
      } finally {
        // Close popup from opener side (in case postback's self-close failed)
        try { if (!popup.closed) popup.close(); } catch { /* ignore */ }
      }
    };

    window.addEventListener("message", handler);

    // BroadcastChannel listener: fallback for COOP-severed popups.
    // When COOP: same-origin blocks window.opener, gpex-cloud redirects
    // to our same-origin /auth/oauth-relay page which posts via BroadcastChannel.
    const channel = new BroadcastChannel("gpex-oauth");
    channel.onmessage = (event: MessageEvent) => {
      const { type } = event.data || {};
      if (type !== "GPEX_OAUTH_CODE" && type !== "GPEX_OAUTH_ERROR") return;

      // BroadcastChannel is inherently same-origin safe — no origin check needed.
      if (settled) return;
      settled = true;
      window.removeEventListener("message", handler);
      channel.close();
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);

      if (type === "GPEX_OAUTH_ERROR") {
        const errorCode = event.data.error || "unknown_error";
        try { if (!popup.closed) popup.close(); } catch { /* ignore */ }
        reject(new Error(errorCode));
        return;
      }

      // Exchange one-time code for tokens via HTTPS
      (async () => {
        try {
          const res = await fetch(`${apiBaseUrl}${API_AUTH_EXCHANGE_CODE}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: event.data.code }),
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            reject(new Error((errData as { error?: string }).error || "Code exchange failed"));
            return;
          }

          const tokens = (await res.json()) as PopupOAuthResult;
          resolve({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          });
        } catch (err) {
          reject(err);
        } finally {
          try { if (!popup.closed) popup.close(); } catch { /* ignore */ }
        }
      })();
    };

    // NOTE: popup.closed polling is intentionally DISABLED.
    //
    // With COOP: same-origin (required for SharedArrayBuffer/WASM), the popup's
    // WindowProxy is permanently severed when navigating cross-origin. This causes
    // popup.closed to return TRUE even while the popup is still open and active.
    // There is no way to distinguish a COOP false positive from a real user close.
    //
    // We rely entirely on:
    //   1. BroadcastChannel for success/error delivery (primary)
    //   2. postMessage as fallback if COOP is somehow relaxed in the future
    //   3. 5-minute timeout as the ultimate safety net
    //
    // If the user manually closes the popup, the timeout will fire eventually.
    // This is acceptable UX since manual closure during OAuth is rare.
    const pollTimer = 0 as unknown as ReturnType<typeof setInterval>; // placeholder for cleanup references

    // Global timeout (5 minutes)
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      window.removeEventListener("message", handler);
      channel.close();
      if (!popup.closed) popup.close();
      reject(new Error("Login timed out"));
    }, 5 * 60 * 1000);
  });
}
