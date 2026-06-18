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
 * CloudMenu / cloud-sdk
 *
 * Unified export for the GPEX Cloud SDK used by the CloudMenu plugin.
 * Self-contained — no external dependencies on gpex-cloud source code.
 *
 * Provides:
 * - Cloud auth state (useGpexCloud → useAuth with GPEX typing)
 * - Cloud storage API (gpexStorage)
 * - Cloud provider component (GpexCloudProvider)
 * - All related types
 */

import { AuthProvider } from "./auth";
import type { GpexCloudProviderProps } from "./types";

// ─── GpexCloudProvider ────────────────────────────────────────────────────────
// Wraps AuthProvider with GPEX-specific defaults (branding, OAuth, endpoint).

const DEFAULT_API_BASE_URL = "https://gpex.cloud" as const;

const GPEX_BRANDING = {
  logoAlt: "GPEX-Cloud",
  title: "Sign In / Up",
  subtitle: "Connect to GPEX Cloud for sync & storage.",
  buttonText: "Continue",
  termsUrl: "https://gpex.cloud/terms",
  privacyUrl: "https://gpex.cloud/privacy",
  footerText: "Secure authentication powered by GPEX-Cloud.",
  accentColor: "#00F2FE",
  accentGradient: "linear-gradient(to right, #00F2FE, #4FACFE)",
};

export function GpexCloudProvider({
  apiBaseUrl,
  children,
}: GpexCloudProviderProps) {
  const url = apiBaseUrl || DEFAULT_API_BASE_URL;
  const branding = { ...GPEX_BRANDING, logo: `${url}/logo.svg` };

  return (
    <AuthProvider
      apiBaseUrl={url}
      branding={branding}
      oauthProviders={["google", "github"]}
    >
      {children}
    </AuthProvider>
  );
}

// ─── Auth hook (re-exported with GPEX naming) ─────────────────────────────────
export { useAuth as useGpexCloud } from "./auth";

// ─── Storage API ──────────────────────────────────────────────────────────────
export {
  gpexStorage,
  save,
  list,
  download,
  remove,
  getQuota,
  share,
  unshare,
} from "./storage";

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  GpexQuota,
  GpexFileItem,
  GpexFileSaveResult,
  GpexShareResult,
  GpexCloudProviderProps,
} from "./types";
