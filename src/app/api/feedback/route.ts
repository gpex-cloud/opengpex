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
 * Feedback BFF relay.
 *
 * The browser only ever calls this same-origin route; it never talks to
 * gpex.cloud directly (immune to ad blockers, no CORS). Unlike the
 * update-check relay this route deliberately does NOT honor DO_NOT_TRACK:
 * that switch stops silent outbound telemetry, while a feedback submission
 * is an explicit, user-authored action whose content the user just typed and
 * can read before sending. Self-host operators who want the outbound traffic
 * documented will find it in TELEMETRY.md.
 *
 * Behavior:
 *   1. Minimal shape check (category / message / diagnostics presence) —
 *      the cloud re-validates authoritatively;
 *   2. Forwards ONLY `Authorization` and `X-Client-Id` (never cookies or any
 *      other client header) and appends the server-resolved `deployment`;
 *   3. POST: cloud 429 passes through with its Retry-After header, any other
 *      failure maps to 502 — a lost feedback must be visible to the user,
 *      never silently degraded;
 *   4. GET: the upstream status passes through (a 401 tells the modal the
 *      session token is stale so it can fall back to the local list); only
 *      network-level failures map to 502.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { resolveDeployment } from '@opengpex/editor/core/system/env';

export const runtime = 'nodejs';

const CLOUD_URL = process.env.NEXT_PUBLIC_GPEX_CLOUD_URL || 'https://gpex.cloud';
const UPSTREAM_TIMEOUT_MS = 5000;

/** The only client headers allowed through to the cloud — no cookies, no
 * referrer, nothing else the browser attached. */
function relayHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const auth = req.headers.get('authorization');
  if (auth) headers.Authorization = auth;
  const clientId = req.headers.get('x-client-id');
  if (clientId) headers['X-Client-Id'] = clientId;
  return headers;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }

  // Minimal shape gate before spending an outbound round trip. Field-level
  // rules (enum / length / diagnostics size) are enforced by the cloud route.
  const b = body as Record<string, unknown> | null;
  const shapeOk =
    !!b &&
    typeof b.category === 'string' &&
    typeof b.message === 'string' &&
    typeof b.diagnostics === 'object' &&
    b.diagnostics !== null;
  if (!shapeOk) {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }

  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const targetUrl = new URL('/api/feedback', CLOUD_URL);
  const payload = JSON.stringify({ ...(body as object), deployment: resolveDeployment(host) });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(targetUrl.toString(), {
      method: 'POST',
      headers: { ...relayHeaders(req), 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });
  } catch {
    // Timeout / network error / offline: the user must see the failure.
    return NextResponse.json({ error: 'submission_failed' }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(data, { status: res.status });
  }
  if (res.status === 429) {
    // Rate limiting is a meaningful answer, not a failure: pass it through
    // with the server's Retry-After so the modal can show a countdown.
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const retryAfter = res.headers.get('Retry-After');
    return NextResponse.json(data, {
      status: 429,
      ...(retryAfter ? { headers: { 'Retry-After': retryAfter } } : {}),
    });
  }
  return NextResponse.json({ error: 'submission_failed' }, { status: 502 });
}

export async function GET(req: NextRequest) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(new URL('/api/feedback', CLOUD_URL).toString(), {
      method: 'GET',
      headers: relayHeaders(req),
      signal: controller.signal,
    });
  } catch {
    return NextResponse.json({ error: 'submission_failed' }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  // Upstream status passes through verbatim: 401 (stale token) tells the
  // modal to fall back to the local list, 200 carries the whitelisted rows.
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(data, { status: res.status });
}
