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
 * cloud-sdk / auth / provider
 *
 * React Context Provider for authentication state.
 * Handles session initialization, login/logout, and state management.
 * Fully self-contained — communicates with gpex-cloud via HTTP only.
 *
 * Always operates in cross-origin mode (opengpex ≠ gpex-cloud domain).
 */

import React, { createContext, useState, useEffect, useCallback, useRef } from "react";
import type { AuthContextValue, AuthProviderProps, AuthUser } from "./types";
import { getAccessToken, getRefreshToken, setAccessToken, setRefreshToken, clearTokens } from "./token-store";
import { initHttpClient, authFetch } from "./http-client";
import { LoginModal } from "./ui/LoginModal";
import { API_AUTH_SESSION, API_AUTH_REFRESH, API_AUTH_LOGOUT, API_AUTH_SSO_CODE } from "../protocol";

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ apiBaseUrl, branding, oauthProviders, children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const initialized = useRef(false);

  const restoreSession = useCallback(async () => {
    try {
      // After page reload, accessToken is lost (memory-only).
      // If we have a refreshToken, exchange it for a new accessToken first.
      if (!getAccessToken() && getRefreshToken()) {
        const refreshRes = await fetch(`${apiBaseUrl}${API_AUTH_REFRESH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: getRefreshToken() }),
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json() as { accessToken?: string; refreshToken?: string };
          if (data.accessToken) setAccessToken(data.accessToken);
          if (data.refreshToken) setRefreshToken(data.refreshToken);
        } else {
          // Refresh token invalid — clear and bail
          clearTokens();
          return;
        }
      }

      // Now fetch session with the (possibly refreshed) access token
      const res = await authFetch(API_AUTH_SESSION);
      if (res.ok) {
        const data = (await res.json()) as { user?: AuthUser };
        if (data.user) { setUser(data.user); return; }
      }
    } catch {
      // Session restore failed — user stays logged out
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl]);

  // Initialize HTTP client on mount (re-init if apiBaseUrl changes)
  useEffect(() => {
    initHttpClient({
      apiBaseUrl,
      onSessionExpired: () => {
        setUser(null);
      },
    });

    if (initialized.current) return;
    initialized.current = true;

    // Check for SSO code in URL (cross-site login sync from gpex-cloud)
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const ssoCode = params.get("sso_code");
      if (ssoCode) {
        // Exchange SSO code for tokens, then restore session
        (async () => {
          try {
            const res = await fetch(`${apiBaseUrl}${API_AUTH_SSO_CODE}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: ssoCode }),
            });

            if (res.ok) {
              const { accessToken, refreshToken } = (await res.json()) as {
                accessToken: string;
                refreshToken: string;
              };
              setAccessToken(accessToken);
              setRefreshToken(refreshToken);
            } else {
              console.warn("[Auth] SSO code exchange failed:", res.status);
            }
          } catch (err) {
            console.error("[Auth] SSO sync failed:", err);
          }

          // Clean URL params from address bar
          const url = new URL(window.location.href);
          url.searchParams.delete("sso_code");
          window.history.replaceState(null, "", url.pathname + url.search);

          // Restore session (will use the tokens we just stored)
          restoreSession();
        })();
        return;
      }
    }

    // Restore existing session (from localStorage tokens)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    restoreSession();
  }, [apiBaseUrl, restoreSession]);

  const openLogin = useCallback(() => setIsLoginOpen(true), []);
  const closeLogin = useCallback(() => setIsLoginOpen(false), []);

  const handleLoginSuccess = useCallback((authUser: AuthUser, tokens?: { accessToken?: string; refreshToken?: string }) => {
    if (tokens?.accessToken) setAccessToken(tokens.accessToken);
    if (tokens?.refreshToken) setRefreshToken(tokens.refreshToken);
    setUser(authUser);
    setIsLoginOpen(false);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await authFetch(API_AUTH_LOGOUT, { method: "POST" });
    } catch {
      // Logout request failed — clear local state anyway
    }
    clearTokens();
    setUser(null);
  }, []);

  const value: AuthContextValue = {
    user,
    isSignedIn: !!user,
    isLoading,
    isLoginOpen,
    openLogin,
    closeLogin,
    signOut,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
      <LoginModal
        isOpen={isLoginOpen}
        onClose={closeLogin}
        onSuccess={handleLoginSuccess}
        apiBaseUrl={apiBaseUrl}
        branding={branding}
        oauthProviders={oauthProviders}
      />
    </AuthContext.Provider>
  );
}
