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

import { useCallback, useEffect, useRef } from 'react';

export interface DebouncedCallback<A extends unknown[]> {
  /** (Re)start the debounce window; a pending call is superseded. */
  schedule: (...args: A) => void;
  /** Drop a pending call without invoking it. */
  cancel: () => void;
  /** Invoke a pending call NOW (last args win); no-op when nothing is pending. */
  flush: () => void;
}

/**
 * useDebouncedCallback — trailing debounce for event-rate writes.
 *
 * Trailing semantics: each `schedule` restarts the window and only the LAST
 * call in a burst fires (typing "10" lands one invocation with the final
 * value, not per-keystroke churn). The callback is invoked through a latest-ref,
 * so the `fn` identity may change every render and the pending fire always
 * executes the freshest closure — inline closures that capture live component
 * state are safe. Unmount cancels a pending fire (dropped, not flushed: the
 * caller's fast-path stores should already hold the value if it matters).
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number
): DebouncedCallback<A> {
  const fnRef = useRef(fn);
  // Latest-ref via effect (not render-time assignment): a pending fire that
  // lands between a render and its effect runs the previous closure, which
  // is one frame stale and harmless for debounce semantics.
  useEffect(() => {
    fnRef.current = fn;
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArgsRef = useRef<A | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    clearTimer();
    pendingArgsRef.current = null;
  }, [clearTimer]);

  const flush = useCallback(() => {
    if (pendingArgsRef.current === null) return;
    const args = pendingArgsRef.current;
    cancel();
    fnRef.current(...args);
  }, [cancel]);

  const schedule = useCallback(
    (...args: A) => {
      clearTimer();
      pendingArgsRef.current = args;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        pendingArgsRef.current = null;
        fnRef.current(...args);
      }, delayMs);
    },
    [clearTimer, delayMs]
  );

  useEffect(() => cancel, [cancel]);

  return { schedule, cancel, flush };
}
