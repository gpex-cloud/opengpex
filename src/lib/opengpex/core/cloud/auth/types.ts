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
 * cloud-sdk / auth / types
 *
 * Public type definitions for the auth client SDK.
 * No server-side secrets or dependencies here.
 */

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  role: string;
}

export interface Branding {
  /** Logo image URL (displayed in login modal header) */
  logo?: string;
  /** Logo alt text */
  logoAlt?: string;
  /** Modal title */
  title?: string;
  /** Modal subtitle / description */
  subtitle?: string;
  /** Submit button text */
  buttonText?: string;
  /** Terms of service URL */
  termsUrl?: string;
  /** Privacy policy URL */
  privacyUrl?: string;
  /** Footer text */
  footerText?: string;
  /** Primary accent color (CSS value) */
  accentColor?: string;
  /** Accent gradient (CSS value) */
  accentGradient?: string;
}

export interface AuthState {
  user: AuthUser | null;
  isSignedIn: boolean;
  isLoading: boolean;
}

export interface AuthContextValue extends AuthState {
  /** Open the login modal */
  openLogin: () => void;
  /** Close the login modal */
  closeLogin: () => void;
  /** Sign out current user */
  signOut: () => Promise<void>;
  /** Whether login modal is open */
  isLoginOpen: boolean;
}

export interface AuthProviderProps {
  /** Base URL of the gpex-cloud API (e.g. "https://gpex.cloud" or "http://localhost:3031") */
  apiBaseUrl: string;
  /** Branding configuration for the login UI */
  branding?: Branding;
  /** List of OAuth providers to show (e.g. ['google']) */
  oauthProviders?: string[];
  /** React children */
  children: React.ReactNode;
}


