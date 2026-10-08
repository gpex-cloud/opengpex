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

'use client';

/**
 * useUpdateChecker — client-side driver for the anonymous update check.
 *
 * Exactly two trigger points, by design (no background periodic timer):
 *   1. Auto: 3s after page load, gated by the 12h localStorage throttle;
 *   2. Manual: user clicks "Check for Updates" (bypasses the throttle).
 *
 * Throttle state lives in localStorage; multiple mounted consumers share one
 * in-flight request via a module-level singleton.
 *
 * The storage/throttle/network logic is factored into exported pure helpers
 * (usable from node-env unit tests); the hook only wires them to React state.
 */

import { useEffect, useState, useCallback } from 'react';
import { getOrCreateClientId } from './client-id';
import { presets } from '@opengpex/editor/core/helpers/preferences';

export const STORAGE_KEY_LAST_CHECK = 'gpex_last_update_check';
export const STORAGE_KEY_CACHED_INFO = 'gpex_cached_update_info';
export const STORAGE_KEY_SKIPPED = 'gpex_skipped_version';
export const THROTTLE_MS = 12 * 60 * 60 * 1000; // 12h client-side throttle
export const AUTO_CHECK_DELAY_MS = 3000;

export interface UpdateInfo {
  hasUpdate: boolean;
  latestVersion?: string;
  currentVersion: string;
  releaseUrl?: string;
  notice?: string;
  isCritical?: boolean;
}

/** Raw cloud response shape (snake_case over the wire). */
interface CheckUpdateResponse {
  has_update: boolean;
  current_version?: string;
  latest_version?: string;
  release_url?: string;
  notice?: string;
  is_critical?: boolean;
}

/** Locally skipped version ("don't prompt for this release again"), if any. */
export function readSkippedVersion(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(STORAGE_KEY_SKIPPED);
  } catch {
    return null;
  }
}

/** Cached update info with the skipped-version suppression applied. */
export function readCachedUpdateInfo(): UpdateInfo | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CACHED_INFO);
    if (!raw) return null;
    const info: UpdateInfo = JSON.parse(raw);
    const skipped = readSkippedVersion();
    if (info.hasUpdate && info.latestVersion && info.latestVersion === skipped) {
      return { ...info, hasUpdate: false };
    }
    return info;
  } catch {
    return null;
  }
}

/**
 * Cached info if the last successful check happened within the 12h throttle
 * window; null otherwise (expired window, never checked, or no cache yet).
 */
export function readThrottledCache(now: number = Date.now()): UpdateInfo | null {
  if (typeof window === 'undefined') return null;
  try {
    const last = Number(localStorage.getItem(STORAGE_KEY_LAST_CHECK) || 0);
    if (!last || now - last >= THROTTLE_MS) return null;
  } catch {
    return null;
  }
  return readCachedUpdateInfo();
}

/** Persists a successful check: throttle timestamp + cached result. */
export function writeCheckResult(info: UpdateInfo): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_LAST_CHECK, String(Date.now()));
    localStorage.setItem(STORAGE_KEY_CACHED_INFO, JSON.stringify(info));
  } catch {
    // Non-fatal: the throttle simply won't persist.
  }
}

// Module-level singleton: many mounted consumers share one in-flight check.
let inflight: Promise<UpdateInfo | null> | null = null;

/**
 * Best-effort client platform self-report via User-Agent Client Hints API.
 * Chromium-only (Safari/Firefox lack userAgentData) — the BFF falls back to
 * UA-string parsing and ultimately 'unknown'. This direct channel is not
 * subject to Accept-CH timing, so the very first check carries the arch.
 */
async function readClientPlatformHints(): Promise<Record<string, string>> {
  const uaData = (navigator as { userAgentData?: { platform?: string; getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> } }).userAgentData;
  if (!uaData?.getHighEntropyValues) return {};
  try {
    const hints: Record<string, string> = {};
    if (uaData.platform) hints['X-Client-OS'] = uaData.platform; // 'macOS' | 'Windows' | 'Linux'
    const high = await uaData.getHighEntropyValues(['architecture']);
    if (high.architecture) hints['X-Client-Arch'] = high.architecture; // 'arm' | 'x86'
    return hints;
  } catch {
    return {};
  }
}

/**
 * Performs the live check against the local BFF route, carrying the anonymous
 * client id in the `X-Client-Id` header. Concurrent callers share the same
 * request. Resolves null on any failure (result NOT cached, so the throttle
 * window doesn't open for a failed check).
 */
export function performUpdateCheck(): Promise<UpdateInfo | null> {
  if (inflight) return inflight;
  inflight = (async (): Promise<UpdateInfo | null> => {
    try {
      const clientId = getOrCreateClientId();
      const hints = await readClientPlatformHints();
      const res = await fetch('/api/system/check-update', {
        headers: {
          ...(clientId ? { 'X-Client-Id': clientId } : {}),
          ...hints,
        },
      });
      if (!res.ok) throw new Error(`check-update failed: ${res.status}`);
      const data: CheckUpdateResponse = await res.json();
      const skipped = readSkippedVersion();
      const hasUpdate = !!data.has_update && data.latest_version !== skipped;

      const info: UpdateInfo = {
        hasUpdate,
        latestVersion: data.latest_version,
        currentVersion: data.current_version || '',
        releaseUrl: data.release_url,
        notice: data.notice,
        isCritical: data.is_critical,
      };

      writeCheckResult(info);
      return info;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useUpdateChecker() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(() => readCachedUpdateInfo());
  const [isChecking, setIsChecking] = useState(false);

  const check = useCallback(async (force = false): Promise<UpdateInfo | null> => {
    const autoCheckEnabled = presets.get('SYSTEM_UPDATES_AUTO_CHECK') !== false;
    if (!autoCheckEnabled && !force) return null;

    // 12h client-side throttle: inside the window, reuse the cached result so
    // UI state survives reloads without a network round-trip.
    if (!force) {
      const cached = readThrottledCache();
      if (cached) {
        setUpdateInfo(cached);
        return cached;
      }
    }

    setIsChecking(true);
    try {
      const info = await performUpdateCheck();
      if (info) setUpdateInfo(info);
      return info;
    } finally {
      setIsChecking(false);
    }
  }, []);

  const skipVersion = useCallback((version: string) => {
    try {
      localStorage.setItem(STORAGE_KEY_SKIPPED, version);
      setUpdateInfo((prev) => (prev ? { ...prev, hasUpdate: false } : null));
    } catch {
      // Non-fatal: without storage the skip just doesn't persist.
    }
  }, []);

  useEffect(() => {
    // Single automatic trigger: 3s after mount. No background periodic timer.
    const timer = setTimeout(() => { check(false); }, AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [check]);

  return { updateInfo, isChecking, checkNow: useCallback(() => check(true), [check]), skipVersion };
}
