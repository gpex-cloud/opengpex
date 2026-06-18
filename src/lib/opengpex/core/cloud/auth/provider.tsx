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
 */

import React, { createContext, useState, useEffect, useCallback, useRef } from "react";
import type { AuthContextValue, AuthProviderProps, AuthUser } from "./types";
import { setAccessToken, setRefreshToken, clearTokens } from "./token-store";
import { initHttpClient } from "./http-client";
import { LoginModal } from "./ui/LoginModal";

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ apiBaseUrl, branding, oauthProviders, children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const initialized = useRef(false);

  const isSameOrigin = useCallback(() => {
    if (!apiBaseUrl || !apiBaseUrl.startsWith("http")) return true;
    try { return new URL(apiBaseUrl).origin === window.location.origin; }
    catch { return true; }
  }, [apiBaseUrl]);

  const restoreSession = useCallback(async () => {
    try {
      const sameOrigin = isSameOrigin();

      if (sameOrigin) {
        // Same-origin: use cookie
        const res = await fetch(`${apiBaseUrl}/api/auth/session`, {
          credentials: "include",
        });
        if (res.ok) {
          const data = (await res.json()) as { user?: AuthUser };
          if (data.user) { setUser(data.user); return; }
        }
      } else {
        // Cross-origin: try refresh token from localStorage to get new access token
        const { getAccessToken, getRefreshToken } = await import("./token-store");
        const existingToken = getAccessToken();

        if (existingToken) {
          // Try with existing access token
          const res = await fetch(`${apiBaseUrl}/api/auth/session`, {
            headers: { Authorization: `Bearer ${existingToken}` },
          });
          if (res.ok) {
            const data = (await res.json()) as { user?: AuthUser };
            if (data.user) { setUser(data.user); return; }
          }
        }

        // Try refresh token (access token expired or missing after page reload)
        const refreshToken = getRefreshToken();
        if (refreshToken) {
          const refreshRes = await fetch(`${apiBaseUrl}/api/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken }),
          });
          if (refreshRes.ok) {
            const refreshData = (await refreshRes.json()) as { accessToken?: string; refreshToken?: string };
            if (refreshData.accessToken) {
              setAccessToken(refreshData.accessToken);
              if (refreshData.refreshToken) setRefreshToken(refreshData.refreshToken);
              // Now fetch session with new token
              const sessionRes = await fetch(`${apiBaseUrl}/api/auth/session`, {
                headers: { Authorization: `Bearer ${refreshData.accessToken}` },
              });
              if (sessionRes.ok) {
                const sessionData = (await sessionRes.json()) as { user?: AuthUser };
                if (sessionData.user) { setUser(sessionData.user); return; }
              }
            }
          } else {
            // Refresh token invalid — clear tokens
            const { clearTokens } = await import("./token-store");
            clearTokens();
          }
        }
      }
    } catch {
      // Session restore failed — user stays logged out
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, isSameOrigin]);

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

    // Restore existing session (from localStorage tokens or cookies)
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
      const sameOrigin = isSameOrigin();

      await fetch(`${apiBaseUrl}/api/auth/logout`, {
        method: "POST",
        credentials: sameOrigin ? "include" : "omit",
      });
    } catch {
      // Logout request failed — clear local state anyway
    }
    clearTokens();
    setUser(null);
  }, [apiBaseUrl, isSameOrigin]);

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
