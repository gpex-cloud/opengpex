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
 * Lightweight environment resolution for the update-check BFF route.
 *
 * Server-side only (imported exclusively by the Node-runtime API route).
 * Zero filesystem access: everything comes from process.env, `node:os` and
 * HTTP headers, so it is safe for serverless deployments.
 */

import os from 'node:os';
import type { NextRequest } from 'next/server';

/** Well-known platform values shared by client_os/client_arch and server_os/server_arch. */
export type PlatformOs = 'darwin' | 'win32' | 'linux' | 'unknown';
export type PlatformArch = 'x64' | 'arm64' | 'unknown';

/**
 * Global telemetry kill switch (https://consoledonottrack.com convention).
 * Environment-level disable wins over any browser-side preference: when set
 * to '1' the BFF route never performs an outbound request.
 */
export function isTelemetryDisabled(): boolean {
  if (typeof process === 'undefined' || !process.env) return false;
  return process.env.DO_NOT_TRACK === '1';
}

/**
 * Deployment host platform (server_os / server_arch), from `node:os`.
 * Reflects the server/container actually running OpenGPEX.
 */
export function resolvePlatform(): { os: PlatformOs; arch: PlatformArch } {
  try {
    return { os: os.platform() as PlatformOs, arch: os.arch() as PlatformArch };
  } catch {
    return { os: 'unknown', arch: 'unknown' };
  }
}

/**
 * User platform (client_os / client_arch). Priority:
 * 1. Explicit self-report headers from the browser (X-Client-OS / X-Client-Arch,
 *    sent by the update-check hook via the User-Agent Client Hints API) —
 *    the only reliable source for macOS, whose User-Agent never carries the arch;
 * 2. Client Hint headers (sec-ch-ua-platform / sec-ch-ua-arch, need Accept-CH opt-in);
 * 3. User-Agent regex (covers Linux/Windows; macOS yields 'unknown' arch).
 * Normalized to a low-cardinality enum for cloud-side aggregation.
 */
export function resolveClientPlatform(req: NextRequest): {
  clientOs: PlatformOs;
  clientArch: PlatformArch;
} {
  const selfOs = (req.headers.get('x-client-os') || '').toLowerCase();
  const selfArch = (req.headers.get('x-client-arch') || '').toLowerCase();
  const hint = (req.headers.get('sec-ch-ua-platform') || '').toLowerCase();
  const archHint = (req.headers.get('sec-ch-ua-arch') || '').toLowerCase();
  const ua = (req.headers.get('user-agent') || '').toLowerCase();

  let clientOs: PlatformOs = 'unknown';
  if (selfOs === 'macos' || selfOs === 'mac') clientOs = 'darwin';
  else if (selfOs === 'windows') clientOs = 'win32';
  else if (selfOs === 'linux' || selfOs === 'android' || selfOs === 'chrome os') clientOs = 'linux';
  else if (hint.includes('mac') || /macintosh|mac os/.test(ua)) {
    clientOs = 'darwin';
  } else if (hint.includes('windows') || /windows/.test(ua)) {
    clientOs = 'win32';
  } else if (hint.includes('linux') || hint.includes('android') || /linux|cros|android/.test(ua)) {
    clientOs = 'linux';
  }

  let clientArch: PlatformArch = 'unknown';
  if (selfArch === 'arm' || selfArch === 'arm64' || selfArch === 'aarch64') clientArch = 'arm64';
  else if (selfArch === 'x86' || selfArch === 'amd64' || selfArch === 'x64' || selfArch === 'x86_64') clientArch = 'x64';
  else if (archHint.includes('arm') || /arm64|aarch64/.test(ua)) {
    clientArch = 'arm64';
  } else if (archHint.includes('x86') || /x86_64|win64|x64/.test(ua)) {
    clientArch = 'x64';
  }

  return { clientOs, clientArch };
}

/**
 * Deployment shape: official cloud service vs user self-hosted.
 *
 * Decided entirely server-side from the Host header, so clients cannot spoof
 * it. Official hosts: gpex.cloud, open.gpex.cloud and v{N}.gpex.cloud — any
 * *.gpex.cloud subdomain counts as cloud.
 */
export function resolveDeployment(host: string | null): 'cloud' | 'self_hosted' {
  const h = (host || '').toLowerCase();
  return h === 'gpex.cloud' || h.endsWith('.gpex.cloud') ? 'cloud' : 'self_hosted';
}
