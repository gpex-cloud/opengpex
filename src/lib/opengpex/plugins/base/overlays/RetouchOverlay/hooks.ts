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

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useEditorState, useEditorServices, usePluginConfig, useVolatileInteraction } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import { exportCloneSources, getCloneOriginFor, getCloneSourceFor, restoreCloneSource, subscribeCloneSource } from './stroke/clone/cloneSource';
import { clearCloneSourceFor } from './stroke/clone/cloneSource';
import { useRetouchCursorFastSync } from './useFastSync';
import { CraftDrawerAPI, MOSAIC_SIZE_PRESETS } from '../../drawers/CraftDrawer/protocols';
import type { CraftDrawerConfig } from '../../drawers/CraftDrawer/protocols';
import { normalizeMosaicMode } from './stroke/types';

// ─── useRetouchOverlayState ─────────────────────────────────────────────────────

/**
 * useRetouchOverlayState: Hook for RetouchOverlay main component state
 *
 * Manages cursor hiding (base cursor 'none') in mosaic mode
 * and Escape exit logic. Returns whether in active mosaic mode.
 */
export function useRetouchOverlayState() {
  const { state, activeFrame } = useEditorState();
  const { actions } = useEditorServices();

  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft] as string | null;
  const isMosaicMode = activeCraft === 'mosaic';

  // Registers the 'none' base cursor so the DOM circle replaces the system
  // cursor; unregistering is owner-scoped to this tool.
  useEffect(() => {
    if (!isMosaicMode) return;
    actions.fast.cursor.register('mosaic', 'none');
    return () => {
      actions.fast.cursor.register('mosaic', null);
    };
  }, [isMosaicMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key exits mosaic mode. It also clears the clone source anchor
  // (explicit-arm semantics: leaving the tool must never leave a stale
  // sample origin behind for the next session).
  useEffect(() => {
    if (!isMosaicMode || !activeFrame) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        clearCloneSourceFor(activeFrame.id);
        actions.executeCommand(CraftDrawerAPI.commands.deactivate.uid);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isMosaicMode, actions, activeFrame]);

  return {
    isMosaicMode,
    activeCraft,
    activeFrame,
  };
}

// ─── useRetouchCursorTracking ───────────────────────────────────────────────────

/**
 * useRetouchCursorTracking: 60fps mouse position tracking + camera.k real-time synchronization
 */
export function useRetouchCursorTracking(
  cursorRef: React.RefObject<HTMLDivElement | null>,
  isActive: boolean,
  brushDiameter: number,
) {
  const pointerRef = useRef({ x: 0, y: 0 });
  const rafIdRef = useRef<number>(0);
  const isVisibleRef = useRef(false);
  const springMetaRef = useRef(false);
  const springChannels = useVolatileInteraction('springChannels');

  // Cmd spring key state, read by the tracking loop below: while held the
  // press routes away from this tool, so the ring must not REVEAL itself.
  // The hide half (muting a visible ring while Cmd is down, restoring on
  // release) is infrastructure: SpringKeyManager mirrors the flag onto
  // <html data-spring-meta> and one global CSS rule mutes every element
  // tagged `data-cursor-indicator` — no per-tool DOM write here.
  useLayoutEffect(() => {
    springMetaRef.current = springChannels.meta;
  }, [springChannels]);

  // Real-time synchronization of cursor size
  useRetouchCursorFastSync(cursorRef, isActive, brushDiameter);

  // Pointer position tracking
  useEffect(() => {
    if (!isActive) {
      const el = cursorRef.current;
      if (el) {
        el.style.opacity = '0';
      }
      isVisibleRef.current = false;
      return;
    }

    const handlePointerMove = (e: PointerEvent) => {
      const viewportContainer = cursorRef.current?.closest('.editor-viewport-container');
      if (!viewportContainer) return;

      const rect = viewportContainer.getBoundingClientRect();
      pointerRef.current.x = e.clientX - rect.left;
      pointerRef.current.y = e.clientY - rect.top;

      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = 0;
          const el = cursorRef.current;
          if (!el) return;

          el.style.transform = `translate(${pointerRef.current.x}px, ${pointerRef.current.y}px)`;

          if (!isVisibleRef.current && !springMetaRef.current) {
            el.style.opacity = '1';
            isVisibleRef.current = true;
          }
        });
      }
    };

    const handlePointerLeave = () => {
      const el = cursorRef.current;
      if (el) {
        el.style.opacity = '0';
        isVisibleRef.current = false;
      }
    };

    const viewportContainer = cursorRef.current?.closest('.editor-viewport-container');
    if (viewportContainer) {
      viewportContainer.addEventListener('pointermove', handlePointerMove as EventListener);
      viewportContainer.addEventListener('pointerleave', handlePointerLeave as EventListener);
    }

    return () => {
      if (viewportContainer) {
        viewportContainer.removeEventListener('pointermove', handlePointerMove as EventListener);
        viewportContainer.removeEventListener('pointerleave', handlePointerLeave as EventListener);
      }
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    };
  }, [isActive, cursorRef]);

  // Alt (spring `alt` channel) drives the clone pick-source badge: while the
  // channel is engaged in clone mode the badge shows the crosshair target
  // glyph ("Alt+Click = pick source"), otherwise it stays hidden. The channel
  // state is read here — NEVER raw key listeners — so the SpringKeyManager's
  // window-blur fallback covers system focus steals (spec §2.2).
  useLayoutEffect(() => {
    const el = cursorRef.current;
    if (!el) return;
    const badge = el.querySelector('[data-badge="clone-source"]') as HTMLElement | null;
    if (!badge) return;
    badge.style.opacity = springChannels.alt ? '1' : '0';
  }, [springChannels, isActive, cursorRef]);
}

// ─── useRetouchParams ───────────────────────────────────────────────────────────

/**
 * useRetouchParams: Reads current mosaic (retouch) parameters
 */
export function useRetouchParams() {
  const [craftConfig] = usePluginConfig<CraftDrawerConfig>(CraftDrawerAPI.configKey);
  const sizePreset = craftConfig?.mosaicSizePreset ?? 'M';
  const presetData = MOSAIC_SIZE_PRESETS[sizePreset as keyof typeof MOSAIC_SIZE_PRESETS] ?? MOSAIC_SIZE_PRESETS['M'];
  const mode = normalizeMosaicMode(craftConfig?.mosaicToolMode);
  const customDiameter = craftConfig?.mosaicStampDiameter;
  const brushDiameter = customDiameter != null && customDiameter > 0 ? customDiameter : presetData.brushDiameter;

  return {
    mode,
    brushDiameter,
  };
}

// ─── Clone indicator hooks (moved from useCloneIndicator.ts) ──────────────────

/**
 * Clone indicator hooks — the CONTROL half of the clone visual affordances
 * (the render half lives in `components.tsx` CloneSourceMarker, which only
 * mounts the DOM these refs bind to).
 *
 * - `useCloneSourcePersistence`: mirrors the in-memory per-frame clone source
 *   registry into pluginConfig (survives refreshes) and restores it back.
 * - `useCloneGhostTracking`: pointer capture + camera math + the ghost
 *   writer's visibility policy, driving the source marker container and the
 *   dashed "copy-from" ghost ring through refs (zero React renders per frame).
 *
 * Performance contract (see core/motion/index.ts pointermove ruling): the
 * pointer-following ghost updates EVENT-SIDE (never waits for ticker ticks —
 * bare pointermove deliberately doesn't wake the ticker from its 4Hz idle
 * throttle), with zero layout reads in handlers or ticks (viewport element +
 * rect cached, rect refreshed by ResizeObserver only), one stable fast-sync
 * subscription (callback identity never changes), and deduplicated DOM writes.
 */


// ─── useCloneSourcePersistence ─────────────────────────────────────────────────

/**
 * Mirrors the per-frame clone source registry into pluginConfig and restores
 * it when (re)entering the tool or switching frames. Restore is validated by
 * frame id + canvas bounds inside the registry module; the module's live
 * state always wins over a stale persisted copy.
 */
export function useCloneSourcePersistence(isMosaicMode: boolean): void {
  const { activeFrame } = useEditorState();
  const [craftConfig, setCraftConfig] = usePluginConfig<CraftDrawerConfig>(CraftDrawerAPI.configKey);
  const frameId = activeFrame?.id ?? null;

  useEffect(() => {
    if (!isMosaicMode || !frameId || !activeFrame) return;
    restoreCloneSource(frameId, activeFrame.canvas, craftConfig.retouchCloneSources?.[frameId]);
    // Deliberately narrow deps: re-restoring on every config write would
    // fight the persist effect below; the module registry is authoritative.
  }, [isMosaicMode, frameId]); // eslint-disable-line react-hooks/exhaustive-deps

  const frameIdRef = useRef(frameId);
  useLayoutEffect(() => { frameIdRef.current = frameId; }, [frameId]);
  const setCraftConfigRef = useRef(setCraftConfig);
  useLayoutEffect(() => { setCraftConfigRef.current = setCraftConfig; }, [setCraftConfig]);
  useEffect(() => subscribeCloneSource(() => {
    const fid = frameIdRef.current;
    if (!fid) return;
    setCraftConfigRef.current({ retouchCloneSources: exportCloneSources() });
  }), []);
}

// ─── useCloneGhostTracking ─────────────────────────────────────────────────────

/**
 * Drives the clone visual affordances through refs:
 * - `containerRef`: camera-follow transform on the marker container;
 * - `ghostRef`: the dashed "copy-from" ring, positioned per pointer move
 *   (event-side — never waits for the throttled ticker) and refreshed per
 *   tick for camera-driven motion;
 * - `source`: the frame's clone source snapshot for rendering the solid
 *   anchor marker (null = nothing to render).
 * Visibility policy (ghost hidden until the first stroke establishes the
 * aligned offset, hidden while Alt picks, hidden off-canvas / non-clone)
 * lives HERE, not in the component.
 */
export function useCloneGhostTracking(): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ghostRef: React.RefObject<HTMLDivElement | null>;
  source: { anchor: { x: number; y: number }; origin: { x: number; y: number } | null } | null;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const { mode } = useRetouchParams();
  const { activeFrame } = useEditorState();
  const { geometry } = useEditorServices();
  const springChannels = useVolatileInteraction('springChannels');
  const frameId = activeFrame?.id ?? '';
  const source = useSyncExternalStore(
    subscribeCloneSource,
    () => (frameId ? getCloneSourceFor(frameId) : null),
  );

  // Pointer cache — viewport-relative coords + inside flag. Zero layout
  // reads per event: the viewport element + rect are cached (ResizeObserver
  // refreshes the rect; handlers only do arithmetic).
  const pointerRef = useRef({ vx: 0, vy: 0, inside: false });
  const vpRectRef = useRef({ left: 0, top: 0, right: 0, bottom: 0 });
  // Latest camera, cached from the ticker for the pointer-side fast path.
  const camRef = useRef<{ x: number; y: number; k: number }>({ x: 0, y: 0, k: 1 });
  useEffect(() => {
    const vp = document.querySelector('.editor-viewport-container') as HTMLElement | null;
    if (!vp) return;
    const refreshRect = () => {
      const r = vp.getBoundingClientRect();
      vpRectRef.current = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    refreshRect();
    const ro = new ResizeObserver(refreshRect);
    ro.observe(vp);
    const onLeave = () => { pointerRef.current.inside = false; };
    vp.addEventListener('pointerleave', onLeave);
    return () => {
      ro.disconnect();
      vp.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  // Alt (pick-source chord) suppresses the ghost: while picking, the pointer
  // means "choose a new origin", not "preview the copy location".
  const altRef = useRef(false);
  useLayoutEffect(() => { altRef.current = springChannels.alt; }, [springChannels]);
  const frameRef = useRef(activeFrame);
  useLayoutEffect(() => { frameRef.current = activeFrame; }, [activeFrame]);
  const modeRef = useRef(mode);
  useLayoutEffect(() => { modeRef.current = mode; }, [mode]);
  const sourceRef = useRef(source);
  useLayoutEffect(() => { sourceRef.current = source; }, [source]);
  const frameIdRef = useRef(frameId);
  useLayoutEffect(() => { frameIdRef.current = frameId; }, [frameId]);
  const geometryRef = useRef(geometry);
  useLayoutEffect(() => { geometryRef.current = geometry; }, [geometry]);

  // ── Ghost writer ──
  // No ghost before the first stroke: with no offset the copied-from
  // location is always the anchor itself (already shown by the source
  // marker) — a cursor-following ring there would imply the source moves
  // with the pointer, which it does not.
  const writeGhost = useCallback((cam: { x: number; y: number; k: number }) => {
    const ghost = ghostRef.current;
    if (!ghost) return;
    const m = modeRef.current;
    const src = sourceRef.current;
    const frame = frameRef.current;
    const p = pointerRef.current;
    if (!getCloneOriginFor(frameIdRef.current)) {
      if (ghost.style.opacity !== '0') ghost.style.opacity = '0';
      return;
    }
    if (m !== 'clone' || !src || !frame || !p.inside || altRef.current) {
      if (ghost.style.opacity !== '0') ghost.style.opacity = '0';
      return;
    }
    const worldPt = geometryRef.current.space.screenToWorld(p.vx, p.vy, frame.canvas, cam);
    const canvasPt = geometryRef.current.space.worldToLocal(worldPt.x, worldPt.y, frame.canvas);
    const origin = getCloneOriginFor(frameIdRef.current);
    if (!origin) return;
    const t = `translate(${src.anchor.x + (canvasPt.x - origin.x)}px, ${src.anchor.y + (canvasPt.y - origin.y)}px)`;
    if (ghost.dataset.t !== t) {
      ghost.dataset.t = t;
      ghost.style.opacity = '1';
      ghost.style.transform = t;
    }
  }, []);

  // Pointermove: the ghost's PRIMARY driver — event-side, synchronous, never
  // gated by the ticker's idle throttle (see the motion governor's comment on
  // pointer-following UI).
  useEffect(() => {
    const vp = document.querySelector('.editor-viewport-container');
    if (!vp) return;
    const onMove = (e: Event) => {
      const pe = e as PointerEvent;
      const { left, top, right, bottom } = vpRectRef.current;
      pointerRef.current.vx = pe.clientX - left;
      pointerRef.current.vy = pe.clientY - top;
      pointerRef.current.inside =
        pe.clientX >= left && pe.clientX <= right && pe.clientY >= top && pe.clientY <= bottom;
      writeGhost(camRef.current);
    };
    vp.addEventListener('pointermove', onMove, { passive: true });
    return () => vp.removeEventListener('pointermove', onMove);
  }, [writeGhost]);

  // ONE stable fast-sync subscription: container transform + ghost refresh
  // for camera-driven motion (pointer stationary, view panning/zooming).
  const ghostTick = useCallback((_v: unknown, _f: unknown, cam: { x: number; y: number; k: number }) => {
    const container = containerRef.current;
    if (container) {
      container.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
    }
    camRef.current = cam;
    writeGhost(cam);
  }, [writeGhost]);
  useFastSync(containerRef, true, ghostTick);

  return { containerRef, ghostRef, source };
}
