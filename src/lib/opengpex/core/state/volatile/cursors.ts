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

import type { RefObject } from 'react';
import type { VolatileState } from '@opengpex/editor/core/types';

/**
 * CursorService: the single resolver for the viewport pointer cursor.
 *
 * Plugins never write the cursor directly. Instead they feed INPUTS to the
 * service and the service computes ONE resolved value from a fixed priority
 * order, which the viewport (and element-level consumers) only read:
 *
 *   Cmd spring key ('move')
 *     > active gesture cursor (handlers declare it on start, clear on end)
 *     > hover declaration (logic-determined hover: pointer inside a polygon
 *       selection, over a draggable anchor/marker, near a resizable edge)
 *     > tool/mode base cursor (registered by the active tool's lifecycle)
 *     > null — the viewport falls back to its per-mode CSS default
 *       (pan=grab, clip=crosshair, craft=default).
 *
 * This replaces the previous single shared cursor field, where
 * every writer did a last-writer-wins stomp (a per-move hover write could
 * erase the Cmd spring cursor and vice versa). Inputs live on the volatile
 * fast track (no React state — 60Hz hover must not trigger renders); the
 * resolved value is published through the same per-field listener mechanism
 * the old field used, so subscribers keep their change notifications.
 *
 * Hover and gesture values are concrete CSS cursor strings owned by the
 * caller ('move', 'grab', directional resize cursors, custom url() cursors) —
 * the service knows no tool vocabulary, it only orders the inputs.
 */

/** Cursor values that mean "move/grab semantics" for element-level consumers. */
export const GLOBAL_CURSORS: ReadonlySet<string> = new Set(['move', 'grab', 'grabbing']);

/** Inputs the pure resolver folds into a single cursor value. */
export interface CursorInput {
  /** Ctrl spring channel engaged — the press will move the layer under the
   * pointer. */
  springMeta: boolean;
  /** Spring key suppressed by a modal context that owns every press (e.g.
   * Re-Canvas): the spring priority stands down while true. */
  springSuppressed: boolean;
  /** Active gesture cursor (null = no gesture). */
  dragging: string | null;
  /** Hover declaration (null = no logic-determined hover). */
  hover: string | null;
  /** Active tool/mode base cursor (null = viewport mode default). */
  tool: string | null;
}

/**
 * Fold the cursor inputs into the one value the viewport shows. Pure so the
 * priority contract is unit-testable in isolation.
 */
export function resolveCursor(input: CursorInput): string | null {
  if (input.springMeta && !input.springSuppressed) return 'move';
  if (input.dragging !== null) return input.dragging;
  if (input.hover !== null) return input.hover;
  return input.tool;
}

export interface CursorService {
  /** Pointer entered (cursor value) / left (null) a logic-determined hover
   * zone. The caller owns the semantics and passes the concrete cursor value
   * (e.g. 'move' over a draggable selection, a directional resize near an
   * edge, a custom url() cursor). */
  notifyHover: (cursor: string | null) => void;
  /** A gesture started (cursor value) or ended (null). */
  notifyDragging: (cursor: string | null) => void;
  /** Re-resolve after an ambient input changed (e.g. spring key toggled). */
  notifyContext: () => void;
  /** Owner-scoped tool/mode base cursor; unregister with null. */
  register: (owner: string, cursor: string | null) => void;
}

export interface CursorServiceDeps {
  /** Live volatile ref (spring channels are read here on every recompute). */
  volatileRef: RefObject<VolatileState>;
  /** Per-field listener notifier (published under 'resolvedCursor'). */
  notify: (key: string) => void;
}

/**
 * Create the cursor service. The owner map lives in this closure — the facade
 * is a per-store singleton, so registrations persist for the editor lifetime
 * and each lifecycle cleans up its own entry on teardown.
 */
export function createCursorService(deps: CursorServiceDeps): CursorService {
  const toolCursors = new Map<string, string>();

  // Service-private inputs. These are facts fed by overlays (hover zones,
  // gesture lifecycles) that NOBODY subscribes to directly — the only
  // observable output is resolvedCursor/globalCursor — so they live in this
  // closure (same as the tool registration map) instead of occupying public
  // volatile slots. Their lifetime is the editor's.
  const inputs = { dragging: null as string | null, hover: null as string | null };

  const recompute = () => {
    const vi = deps.volatileRef.current.interaction;
    let tool: string | null = null;
    for (const cursor of toolCursors.values()) { tool = cursor; break; }
    const resolved = resolveCursor({
      springMeta: vi.springChannels.meta,
      springSuppressed: vi.springSuppressed,
      dragging: inputs.dragging,
      hover: inputs.hover,
      tool,
    });
    // Two consumption views of ONE resolution: the viewport shows every
    // value; elements with their own base cursor only yield to the global
    // (object-manipulation) family — the family policy stays service-side.
    const global = resolved !== null && GLOBAL_CURSORS.has(resolved) ? resolved : null;
    if (vi.resolvedCursor === resolved && vi.globalCursor === global) return;
    vi.resolvedCursor = resolved;
    vi.globalCursor = global;
    deps.notify('resolvedCursor');
    deps.notify('globalCursor');
  };

  return {
    notifyHover: (cursor) => {
      if (inputs.hover === cursor) return;
      inputs.hover = cursor;
      recompute();
    },
    notifyDragging: (cursor) => {
      if (inputs.dragging === cursor) return;
      inputs.dragging = cursor;
      recompute();
    },
    notifyContext: recompute,
    register: (owner, cursor) => {
      if (cursor === null) toolCursors.delete(owner);
      else toolCursors.set(owner, cursor);
      recompute();
    },
  };
}
