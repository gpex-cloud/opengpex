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
 * Update-check BFF relay.
 *
 * The browser only ever calls this same-origin route; it never talks to
 * api.gpex.cloud directly (immune to ad blockers, no CORS). This handler:
 *   1. Honors the server-side kill switch (highest priority, no outbound call);
 *   2. Appends the four non-identifying environment fields (user platform from
 *      browser UA hints, deployment host platform from node:os, deployment shape);
 *   3. Relays to the cloud telemetry endpoint with a 3.5s timeout, silently
 *      degrading to "no update" on any network failure.
 *
 * The anonymous client id travels in the `X-Client-Id` request header (never
 * in the query string) so it stays out of access logs by construction.
 */

import { NextResponse, type NextRequest } from 'next/server';
import packageJson from '../../../../../package.json';
import {
  isTelemetryDisabled,
  resolveClientPlatform,
  resolveDeployment,
  resolvePlatform,
} from '@opengpex/editor/core/system/env';

export const runtime = 'nodejs';

const CLOUD_URL = process.env.NEXT_PUBLIC_GPEX_CLOUD_URL || 'https://gpex.cloud';
const UPSTREAM_TIMEOUT_MS = 3500;

export async function GET(req: NextRequest) {
  const currentVersion = packageJson.version;

  // 1. Server-side global disable — highest priority, never any outbound call.
  if (isTelemetryDisabled()) {
    return NextResponse.json({
      has_update: false,
      disabled: true,
      current_version: currentVersion,
    });
  }

  // 2. Assemble the upstream request with the non-identifying environment fields.
  const server = resolvePlatform();
  const client = resolveClientPlatform(req);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const deployment = resolveDeployment(host);
  const clientId = req.headers.get('x-client-id') || 'anonymous';

  const targetUrl = new URL('/api/telemetry/check-update', CLOUD_URL);
  targetUrl.searchParams.set('current_version', currentVersion);
  targetUrl.searchParams.set('client_os', client.clientOs);
  targetUrl.searchParams.set('client_arch', client.clientArch);
  targetUrl.searchParams.set('server_os', server.os);
  targetUrl.searchParams.set('server_arch', server.arch);
  targetUrl.searchParams.set('deployment', deployment);

  // 3. Relay with a fast timeout; any failure degrades silently to "no update"
  //    so the update check can never block or break the editor.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const res = await fetch(targetUrl.toString(), {
      headers: {
        Accept: 'application/json',
        'X-Client-Id': clientId,
        'User-Agent': `OpenGPEX/${currentVersion} (${client.clientOs}; ${client.clientArch})`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({ ...data, current_version: currentVersion });
    }
  } catch {
    // Network failure / offline / timeout: silent degradation.
  }

  return NextResponse.json({
    has_update: false,
    current_version: currentVersion,
    checked_at: new Date().toISOString(),
  });
}
