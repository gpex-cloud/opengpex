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
 * Anonymous update-check client identity.
 *
 * One client id = one browser = one anonymous active user. The id is a random
 * UUID v4 generated on first visit and persisted in localStorage. It carries
 * no personal information and never leaves the browser except inside the
 * `X-Client-Id` request header of the update-check ping.
 */

const STORAGE_KEY_CLIENT_ID = 'gpex_telemetry_client_id';

/**
 * Returns the stable anonymous client id for this browser.
 *
 * - Server side (SSR): returns '' — the caller must omit the header.
 * - Storage failures (private mode, quota): falls back to a per-call random
 *   UUID so a check is still possible, just not stable across reloads.
 */
export function getOrCreateClientId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = localStorage.getItem(STORAGE_KEY_CLIENT_ID);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY_CLIENT_ID, id);
    }
    return id;
  } catch {
    try {
      return crypto.randomUUID();
    } catch {
      return 'anonymous';
    }
  }
}
