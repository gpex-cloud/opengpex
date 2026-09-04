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
 * Shared SSRF guard for server-side proxy routes (ai-proxy, comfy, ...).
 *
 * Two layers of protection:
 *
 *  1. Link-local / cloud metadata (169.254.x.x) is ALWAYS blocked, regardless
 *     of configuration. There is no legitimate reason for a proxy target to be
 *     the cloud instance metadata service (AWS/GCP/Azure), and reaching it can
 *     leak IAM credentials.
 *
 *  2. Private / LAN targets (localhost, 10.x, 192.168.x, 172.16-31.x, ::1) are
 *     ALLOWED BY DEFAULT so self-hosting users can proxy to LocalAI, Ollama,
 *     ComfyUI, LM Studio, etc. They are only blocked when the environment
 *     variable GPEX_API_ROUTE_BLOCK_LAN=true is set — intended for public
 *     multi-tenant SaaS hosting.
 *
 * Usage (in a Next.js route handler):
 *
 *   const verdict = checkSsrfTarget(parsedUrl.hostname);
 *   if (!verdict.allowed) {
 *     return NextResponse.json({ error: { message: verdict.reason } }, { status: 403 });
 *   }
 */

export interface SsrfVerdict {
  allowed: boolean;
  /** Human-readable reason, present only when allowed === false. */
  reason?: string;
}

/**
 * Returns true if the LAN/private-network block is enabled via env.
 * Defaults to false (allow private targets) when unset — safe for self-hosting.
 */
export function isLanBlockEnabled(): boolean {
  return process.env.GPEX_API_ROUTE_BLOCK_LAN === 'true';
}

/**
 * Cloud instance metadata service — link-local 169.254.0.0/16.
 * Always blocked, cannot be overridden.
 */
export function isCloudMetadataHost(hostname: string): boolean {
  return hostname === '169.254.169.254' || hostname.startsWith('169.254.');
}

/**
 * Detects private / loopback / LAN hostnames.
 *
 * Note the RFC 1918 172.16.0.0/12 range is 172.16.x – 172.31.x ONLY; a naive
 * `startsWith('172.')` would wrongly flag public addresses like 172.0.x or
 * 172.32.x, so the second octet is range-checked here.
 */
export function isPrivateHost(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1'
  ) {
    return true;
  }

  if (hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
    return true;
  }

  // 172.16.0.0/12 → second octet in [16, 31]
  const m = /^172\.(\d{1,3})\./.exec(hostname);
  if (m) {
    const octet = Number(m[1]);
    if (octet >= 16 && octet <= 31) return true;
  }

  return false;
}

/**
 * Evaluates whether a proxy target hostname is allowed.
 *
 * @param hostname  URL.hostname of the target
 * @param options.blockLan  Override for the LAN block. Defaults to reading
 *                          GPEX_API_ROUTE_BLOCK_LAN from the environment.
 */
export function checkSsrfTarget(
  hostname: string,
  options?: { blockLan?: boolean },
): SsrfVerdict {
  // Layer 1: always block cloud metadata.
  if (isCloudMetadataHost(hostname)) {
    return { allowed: false, reason: 'Cloud metadata service access not allowed' };
  }

  // Layer 2: block private/LAN targets only when explicitly enabled.
  const blockLan = options?.blockLan ?? isLanBlockEnabled();
  if (blockLan && isPrivateHost(hostname)) {
    return {
      allowed: false,
      reason: 'Internal network targets not allowed on this public SaaS server',
    };
  }

  return { allowed: true };
}
