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
 * /auth/oauth-relay
 *
 * Same-origin relay page for OAuth popup flow.
 *
 * Problem: opengpex sets COOP: same-origin (required for SharedArrayBuffer/WASM),
 * which severs window.opener in cross-origin popups. The gpex-cloud postback page
 * cannot use postMessage to communicate with the opener.
 *
 * Solution: gpex-cloud redirects to this same-origin relay page after OAuth completes.
 * Since this page shares the same origin as the opener (opengpex), it can use
 * BroadcastChannel to deliver the OAuth code/error to the opener tab.
 *
 * Flow:
 * 1. gpex-cloud /auth/postback detects window.opener is null
 * 2. Redirects to {opengpexOrigin}/auth/oauth-relay?code=xxx (or ?error=xxx)
 * 3. This page sends the code/error via BroadcastChannel("gpex-oauth")
 * 4. The opener's oauth-popup.ts receives the message
 * 5. This page closes itself
 *
 * Query params:
 *   - code: One-time OAuth code (on success)
 *   - error: Error code (on failure)
 */
"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function OAuthRelayInner() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const code = searchParams.get("code");
    const error = searchParams.get("error");

    // Post the OAuth result via BroadcastChannel (same-origin communication)
    const channel = new BroadcastChannel("gpex-oauth");

    if (code) {
      channel.postMessage({ type: "GPEX_OAUTH_CODE", code });
    } else if (error) {
      channel.postMessage({ type: "GPEX_OAUTH_ERROR", error });
    }

    channel.close();

    // Close this popup window after a short delay
    setTimeout(() => window.close(), 300);
  }, [searchParams]);

  return (
    <p>Login successful. Closing...</p>
  );
}

export default function OAuthRelayPage() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: "#0a0a0a",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <Suspense fallback={<p>Loading...</p>}>
        <OAuthRelayInner />
      </Suspense>
      <p style={{ fontSize: "0.75rem", color: "#888" }}>
        If this window doesn&apos;t close automatically, you can close it manually.
      </p>
    </div>
  );
}
