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
 * 2. Provider authorizes → Supabase callback → gpex-cloud generates one-time code
 * 3. Popup postMessage sends code to opener (this window)
 * 4. This function calls /api/auth/exchange-code to get tokens
 * 5. Promise resolves with { accessToken, refreshToken }
 */
export function popupOAuth(config: PopupOAuthConfig): Promise<PopupOAuthResult> {
  const { apiBaseUrl, provider } = config;
  const origin = window.location.origin;

  return new Promise((resolve, reject) => {
    const popupUrl = `${apiBaseUrl}/auth/oauth-popup?provider=${encodeURIComponent(provider)}&origin=${encodeURIComponent(origin)}`;

    // Center the popup on screen
    const width = 500;
    const height = 650;
    const left = Math.round((screen.width - width) / 2);
    const top = Math.round((screen.height - height) / 2);
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
        const res = await fetch(`${apiBaseUrl}/api/auth/exchange-code`, {
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

    // Poll to detect if user closed the popup manually.
    // Note: COOP (Cross-Origin-Opener-Policy) may block `popup.closed` access
    // when the popup navigates cross-origin. We wrap in try-catch to handle this.
    const pollTimer = setInterval(() => {
      try {
        if (popup.closed && !settled) {
          settled = true;
          clearInterval(pollTimer);
          clearTimeout(timeoutTimer);
          window.removeEventListener("message", handler);
          reject(new Error("Login cancelled by user"));
        }
      } catch {
        // COOP blocked access to popup.closed — ignore, rely on postMessage or timeout
      }
    }, 500);

    // Global timeout (5 minutes)
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      window.removeEventListener("message", handler);
      if (!popup.closed) popup.close();
      reject(new Error("Login timed out"));
    }, 5 * 60 * 1000);
  });
}
