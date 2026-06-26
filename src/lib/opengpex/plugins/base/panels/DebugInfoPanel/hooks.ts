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

/* eslint-disable react-hooks/refs */

'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useEditorState, useEditorServices, usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import { resourceTracker } from '@opengpex/editor/core/advanced/ResourceTracker';
import type { ResourceSummary } from '@opengpex/editor/core/advanced/ResourceTracker';
import * as P from './protocols';
import { CLIP_OPTIONS_SIGNAL_RE_CANVAS } from '../../options/ClipOptions/protocols';

// ─── Performance Metrics Types ───────────────────────────────────────────────

export interface PerfMetrics {
  fps: number;
  frameTime: number;
}

export interface MemoryMetrics {
  /** JS Heap info (Chrome only, null on other browsers) */
  jsHeap: { used: number; total: number; limit: number; pct: number } | null;
  /** Whether performance.memory API is available */
  available: boolean;
}

export interface DebugMetrics {
  activeLayer: {
    id: string;
    name: string;
    type: string;
    role: string;
    visible: boolean;
    locked: boolean;
    opacity: number;
    rotation: number;
    scale: number;
    width: number;
    height: number;
    local: { x: number; y: number };
    physical: { x: number; y: number };
  } | null;
  mouse: {
    world: { x: number; y: number };
    physical: { x: number; y: number };
  };
  crop: {
    physical: { x: number; y: number; w: number; h: number };
  };
  camera: { x: number; y: number };
  canvas: {
    original: { w: number; h: number };
  };
  viewport: { w: number; h: number };
  scale: number;
  dpr: number;
  interactionMode: string;
}

// ─── usePerformanceMetrics: RAF-driven FPS counter ───────────────────────────

export const usePerformanceMetrics = (enabled: boolean): PerfMetrics => {
  const [perf, setPerf] = useState<PerfMetrics>({ fps: 0, frameTime: 0 });
  const fpsRef = useRef({ frames: 0, lastTime: 0 });

  useEffect(() => {
    if (!enabled) return;
    let rafId: number;
    // Initialize lastTime when the effect starts (not during render)
    fpsRef.current = { frames: 0, lastTime: performance.now() };

    const tick = () => {
      const now = performance.now();
      fpsRef.current.frames++;

      const elapsed = now - fpsRef.current.lastTime;
      if (elapsed >= 1000) {
        const fps = Math.round((fpsRef.current.frames * 1000) / elapsed);
        const frameTime = Math.round((elapsed / fpsRef.current.frames) * 10) / 10;
        fpsRef.current = { frames: 0, lastTime: now };
        setPerf({ fps, frameTime });
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [enabled]);

  return perf;
};

// ─── useMemoryMetrics: Real JS Heap (Chrome) with 2s sampling ────────────────

export const useMemoryMetrics = (enabled: boolean): MemoryMetrics => {
  const [mem, setMem] = useState<MemoryMetrics>({ jsHeap: null, available: false });

  useEffect(() => {
    if (!enabled) return;

    const collect = () => {
      const perf = performance as Performance & {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
      };

      if (perf.memory) {
        setMem({
          available: true,
          jsHeap: {
            used: perf.memory.usedJSHeapSize,
            total: perf.memory.totalJSHeapSize,
            limit: perf.memory.jsHeapSizeLimit,
            pct: perf.memory.usedJSHeapSize / perf.memory.jsHeapSizeLimit,
          },
        });
      } else {
        setMem({ available: false, jsHeap: null });
      }
    };

    collect(); // Initial
    const timer = setInterval(collect, 2000);
    return () => clearInterval(timer);
  }, [enabled]);

  return mem;
};

// ─── Resource Metrics Types ──────────────────────────────────────────────────

export interface AppResourceMetrics {
  /** Assets from AssetService pool (real blob sizes) */
  assets: { count: number; totalBytes: number };
  /** ResourceTracker summary (undo, buffers, etc.) */
  tracked: ResourceSummary;
  /** Combined total */
  totalAppBytes: number;
}

// ─── useResourceMetrics: Asset pool + ResourceTracker (2s sampling) ──────────

export const useResourceMetrics = (enabled: boolean): AppResourceMetrics => {
  const { assets } = useEditorServices();
  const [res, setRes] = useState<AppResourceMetrics>({
    assets: { count: 0, totalBytes: 0 },
    tracked: { totalBytes: 0, totalCount: 0, byCategory: {}, top5: [] },
    totalAppBytes: 0,
  });

  useEffect(() => {
    if (!enabled) return;

    const collect = () => {
      // Query real asset pool
      const pool = assets.getPool();
      const entries = Object.values(pool);
      let assetBytes = 0;
      for (const entry of entries) {
        if (entry.blob) {
          assetBytes += entry.blob.size;
        }
      }

      // Query ResourceTracker
      const trackerSummary = resourceTracker.getSummary();

      setRes({
        assets: { count: entries.length, totalBytes: assetBytes },
        tracked: trackerSummary,
        totalAppBytes: assetBytes + trackerSummary.totalBytes,
      });
    };

    collect();
    const timer = setInterval(collect, 2000);
    return () => clearInterval(timer);
  }, [enabled, assets]);

  return res;
};

// ─── useDebugInfo: Main hook ─────────────────────────────────────────────────

export const useDebugInfo = () => {
  const { state, activeFrame, activeLayer } = useEditorState();
  const { actions, geometry } = useEditorServices();
  const [selfConfig] = usePluginSelfConfig<P.DebugConfig>();
  const { toggleCmd } = usePluginCommands();
  const isEnabled = selfConfig?.enabled ?? false;

  // Performance metrics (RAF-driven, 1Hz setState)
  const perf = usePerformanceMetrics(isEnabled);

  // Memory metrics (2s interval)
  const memory = useMemoryMetrics(isEnabled);

  // App resource metrics (asset pool + ResourceTracker, 2s interval)
  const resources = useResourceMetrics(isEnabled);

  // RAF-throttled tick for cursor + coordinate data (replaces setInterval 60ms)
  const [tick, setTick] = useState(0);
  const rafTickRef = useRef<number>(0);

  useEffect(() => {
    if (!isEnabled) return;
    let rafId: number;
    let lastUpdate = 0;

    const loop = () => {
      const now = performance.now();
      // Update at ~15Hz (every 66ms) - sufficient for coordinate display, much lighter than 60fps
      if (now - lastUpdate >= 66) {
        lastUpdate = now;
        setTick(t => t + 1);
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [isEnabled]);

  // Real-time mouse position tracking (Refs for performance)
  const mouseRef = useRef({ vx: 0, vy: 0 });

  useEffect(() => {
    if (!isEnabled) return;
    const container = document.querySelector('.editor-viewport-container');

    const handleMouseMove = (e: MouseEvent) => {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      mouseRef.current = {
        vx: Math.round(e.clientX - rect.left),
        vy: Math.round(e.clientY - rect.top)
      };
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [isEnabled]);

  // Data layer: all physical metrics calculations
  const metrics = useMemo((): DebugMetrics | null => {
    void tick;
    void rafTickRef.current;
    const isReady = isEnabled && activeFrame;

    if (!isReady) return null;

    const currentMouse = mouseRef.current;
    const cam = actions.fast.latestCamera(activeFrame.id);
    const layer = activeLayer ? actions.fast.latestLayer(activeFrame.id, activeLayer.id) : null;

    // Layer core metrics
    let activeLayerMetrics: DebugMetrics['activeLayer'] = null;
    if (layer) {
      const worldPos = { x: layer.cx, y: layer.cy };
      const pPos = geometry.space.worldToLocal(worldPos.x, worldPos.y, activeFrame);
      const localX = pPos.x - layer.bounding.w / 2;
      const localY = pPos.y - layer.bounding.h / 2;
      activeLayerMetrics = {
        id: layer.id,
        name: layer.name,
        type: layer.type,
        role: layer.role ?? '',
        visible: layer.visible,
        locked: layer.locked,
        opacity: layer.opacity,
        rotation: layer.rotation,
        scale: layer.scale,
        width: layer.bounding.w,
        height: layer.bounding.h,
        physical: pPos,
        local: { x: localX, y: localY },
      };
    }

    // Mouse core metrics
    const mouseW = geometry.space.screenToWorld(currentMouse.vx, currentMouse.vy, activeFrame, cam);
    const mouseP = geometry.space.screenToLocal(currentMouse.vx, currentMouse.vy, activeFrame, cam);

    // Clip core metrics
    const isReCanvas = state.getStateSignal(CLIP_OPTIONS_SIGNAL_RE_CANVAS);
    const cropShape = isReCanvas ? activeFrame.canvasCropBox : getRegularClipShape(activeFrame);
    const cropBox = cropShape?.rect || { x: 0, y: 0, w: 0, h: 0 };

    return {
      activeLayer: activeLayerMetrics,
      mouse: {
        world: mouseW,
        physical: mouseP,
      },
      crop: {
        physical: cropBox,
      },
      camera: cam,
      canvas: {
        original: activeFrame.canvas,
      },
      viewport: state.ui.viewportDim,
      scale: geometry.getScale(activeFrame, cam),
      dpr: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
      interactionMode: state.interaction.interactionMode ?? 'select',
    };
  }, [tick, isEnabled, activeFrame, activeLayer, geometry, state, actions.fast]);

  return {
    metrics,
    perf,
    memory,
    resources,
    toggleCmd,
    isEnabled
  };
};
