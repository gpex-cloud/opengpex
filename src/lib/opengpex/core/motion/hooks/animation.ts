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

import { useLayoutEffect, useCallback, useState, useRef, useMemo } from 'react';
import { Frame, Layer, VolatileState } from '@opengpex/editor/core/types';
import { Motion } from '../index';
import { LayerUtils } from '@opengpex/editor/core/layer/LayerUtils';
import { useEditorServices, useEditorState } from '@opengpex/editor/core/context';

/**
 * useGeometrySync: Industrial-grade geometric state synchronization hook
 * It not only listens for rotation angle changes, but also supports triggering instantaneous sync protocols via extraSignal (e.g., flip state).
 */
export function useGeometrySync(currentRotation: number, extraSignal?: unknown) {
  const lastRotRef = useRef(currentRotation);
  const lastSignalRef = useRef(extraSignal);
  const isInitialRef = useRef(true);

  // 1. Detect rotation changes
  const rotationDelta = isInitialRef.current ? 0 : currentRotation - lastRotRef.current;
  const rotationChanged = rotationDelta !== 0;

  // 2. Detect extra signal changes (e.g., flip)
  const signalChanged = !isInitialRef.current && lastSignalRef.current !== extraSignal;

  // 3. Comprehensive check: as long as any core geometric property changes, enter the "rigid body sync phase"
  const isSyncing = rotationChanged || signalChanged;

  // Only non-zero rotations that are multiples of 90 degrees are determined as "rotation swap"
  const isRotationSwap = rotationChanged && (rotationDelta % 90 === 0);

  const isInitial = isInitialRef.current;

  // 4. Critical: move reference updates to the Effect stage
  useLayoutEffect(() => {
    lastRotRef.current = currentRotation;
    lastSignalRef.current = extraSignal;
    isInitialRef.current = false;
  }, [currentRotation, extraSignal]);

  /**
   * Get sync parameters dynamically:
   * If rigid body sync is in progress, return duration 0 (instant)
   * Otherwise, return the default transform parameters from the current Motion configuration (smooth)
   */
  const syncProps = isSyncing
    ? { duration: 0, ease: 'none' }
    : Motion.getCurrentConfig();

  return {
    isInitial,
    isSyncing,
    isRotationSwap,
    delta: rotationDelta,
    prevRotation: lastRotRef.current,
    syncProps
  };
}

/**
 * useAnimate: Smart animation hook
 * It automatically decides whether to execute GSAP tweening or instant homing (Rigid Body) based on the "physical geometry sync" state.
 * 
 * @param rotation Current global rotation angle
 * @param extraSyncSignal Extra sync signal (e.g. mirror/flip state), any change triggers instant placement
 * @returns { animate: Function, syncProps: object, isSyncing: boolean }
 */
export function useAnimate(rotation: number, extraSyncSignal?: unknown) {
  const { isInitial, isSyncing, syncProps } = useGeometrySync(rotation, extraSyncSignal);

  /**
   * Animation proxy method
   * 1. Industrial-grade sync: if it's the initial frame (Hydration/Mount), force physical alignment (Baseline Lock).
   * 2. Interaction sync: if geometric transform is in progress (rotation/flip), execute instant response.
   * 3. Otherwise, execute smooth tween.
   */
  const animate = useCallback((target: HTMLElement | Record<string, unknown> | null, vars: Record<string, unknown>, options: { force?: boolean } = {}) => {
    if ((isInitial || isSyncing) && !options.force) {
      const result = Motion.set(target, vars);
      if (typeof vars.onComplete === 'function') (vars.onComplete as () => void)();
      return result;
    }
    return Motion.to(target, {
      ...vars,
      ...syncProps
    });
  }, [isInitial, isSyncing, syncProps]);

  return { animate, syncProps, isSyncing, isInitial };
}

/**
 * useTicker: React-friendly global frame clock hook
 * Handles automatic subscription and cleanup of GSAP Ticker, preventing memory leaks.
 * 
 * @param callback Callback executed every frame
 */
export function useTicker(callback: (time: number, deltaTime: number, frame: number, elapsed: number) => void) {
  useLayoutEffect(() => {
    Motion.ticker.add(callback);
    return () => Motion.ticker.remove(callback);
  }, [callback]);
}

/**
 * useLayerSync: Industrial-grade layer sync master
 * Automatically handles two-way switching between tween animation (GSAP) and physical fast-track (Ticker), hiding matrix computation details.
 * 
 * @param ref Target DOM reference
 * @param layer Layer data object
 * @param volatileRef Fast-track interaction state reference
 * @param extraVars Extra GSAP properties
 */
export function useLayerSync(
  ref: React.RefObject<HTMLElement | null>,
  layer: Layer,
  volatileRef: React.RefObject<VolatileState>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraVars?: Record<string, any>
) {
  const { state } = useEditorState();
  const frameId = state.activeFrameId;
  const { animate } = useAnimate(layer.rotation, layer.flip);
  const isFirstMount = useRef(true);

  // 1. Unified property mapping logic (The Single Source of Truth)
  const resolveVars = useCallback((l: Layer, v?: VolatileState) => {
    // Get the latest rotation/scale for tweening, use original data if not passed
    // [Fix] Use composite key (frameId:layerId) to ensure artboard state isolation
    const cKey = frameId ? LayerUtils.getCompositeKey(frameId, l.id) : l.id;
    const draft = v?.buffered?.layers?.[cKey];
    const merged = LayerUtils.mergeLayerDraft(l, draft);
    
    const { rotation, cx, cy } = merged;

    // What we need is the position of the visible center point in the World coordinate system
    const worldCenter = { x: cx, y: cy };

    // Projection calculation (taking flip into account for GSAP scale usage)
    const fx = l.flip?.h ? -1 : 1;
    const fy = l.flip?.v ? -1 : 1;

    // Prepare variables for GSAP, filter out custom non-standard properties to avoid warnings
    const gsapExtraVars = extraVars || {};

    return {
      x: worldCenter.x,
      y: worldCenter.y,
      scaleX: fx,
      scaleY: fy,
      rotation: rotation,
      opacity: l.visible ? (gsapExtraVars.opacity ?? l.opacity ?? 1) : 0,
      xPercent: -50,
      yPercent: -50,
      ...gsapExtraVars
    };
  }, [frameId, extraVars]);

  // 2. Compute atomic initial style (Atomic Initial Style)
  const syncStyle = useMemo(() => {
    const vars = resolveVars(layer);
    return {
      position: 'absolute' as const,
      top: '50%',
      left: '50%',
      transform: `translate(${vars.x}px, ${vars.y}px) translate(-50%, -50%) scale(${vars.scaleX}, ${vars.scaleY}) rotate(${vars.rotation}deg)`,
      opacity: vars.opacity,
      willChange: 'transform, opacity',
      ...(extraVars?.style || {})
    };
  }, [layer, resolveVars, extraVars]);

  // 3. Main track sync: handles property transforms and animation tweens
  useLayoutEffect(() => {
    if (!ref.current) return;
    const vars = resolveVars(layer);

    if (isFirstMount.current) {
      Motion.set(ref.current, vars);
      isFirstMount.current = false;
    } else {
      animate(ref.current, vars, { force: volatileRef.current.activeState.interacting });
    }
  }, [layer, animate, resolveVars, volatileRef, ref]);

  const compositeKey = useMemo(() => frameId ? LayerUtils.getCompositeKey(frameId, layer.id) : null, [frameId, layer.id]);
  const parentCompositeKey = useMemo(() => (frameId && layer.hostId) ? LayerUtils.getCompositeKey(frameId, layer.hostId) : null, [frameId, layer.hostId]);

  // 4. Fast track sync: subscribe to Ticker to achieve zero-latency high-frequency interactions
  useTicker(() => {
    const v = volatileRef.current;
    if (!v.activeState.interacting || !ref.current || !compositeKey) return;

    // Logic: synchronize if the current layer is in the buffer (being operated on) or is a sublayer of the operated layer
    const isTarget = v.buffered.layers[compositeKey] !== undefined;
    const isChildOfTarget = parentCompositeKey ? v.buffered.layers[parentCompositeKey] !== undefined : false;

    if (isTarget || isChildOfTarget) {
      const vars = resolveVars(layer, v);
      Motion.set(ref.current, vars);
    }
  });

  return { syncStyle };
}

/**
 * useViewportSync: Unified viewport synchronization hook
 * Automatically integrates motion alignment protocols and physical fast-track hijacking, completely closing the Viewport component logic loop.
 */
export function useViewportSync(
  stageRef: React.RefObject<HTMLElement | null>,
  artboardRef: React.RefObject<HTMLElement | null>,
  frame: Frame,
  volatileRef: React.RefObject<VolatileState>
) {
  const [isGroomed, setIsGroomed] = useState(false);
  const lastKRef = useRef(0);
  const lastIdRef = useRef(frame.id);
  const lastCanvasRef = useRef({ w: frame.canvas.w, h: frame.canvas.h });

  // 1. Get geometric transformation signals (rotation/flip)
  const firstLayerId = frame.layers.order[0];
  const flipSignal = firstLayerId ? JSON.stringify(frame.layers.byId[firstLayerId]?.flip) : undefined;
  const { isSyncing: geometryChanged, isRotationSwap, delta } = useGeometrySync(frame.rotation, flipSignal);

  // 2. Execute discrete geometric sync protocol (GSAP alignment)
  useLayoutEffect(() => {
    const isInteracting = volatileRef.current.activeState.interacting;

    Motion.syncViewportGeometry({
      stage: stageRef.current,
      artboard: artboardRef.current,
      current: {
        x: frame.camera.x,
        y: frame.camera.y,
        k: frame.camera.k,
        w: frame.canvas.w,
        h: frame.canvas.h,
        rotation: frame.rotation,
        id: frame.id
      },
      prev: {
        k: lastKRef.current,
        id: lastIdRef.current,
        w: lastCanvasRef.current.w,
        h: lastCanvasRef.current.h
      },
      interaction: {
        isInteracting,
        rotationChanged: geometryChanged,
        isRotationSwap,
        delta
      },
      onGroomed: () => setIsGroomed(true)
    });

    // Synchronize reference for comparison in the next frame
    lastKRef.current = frame.camera.k;
    lastIdRef.current = frame.id;
    lastCanvasRef.current = { w: frame.canvas.w, h: frame.canvas.h };
  }, [frame, geometryChanged, isRotationSwap, delta, volatileRef, stageRef, artboardRef]);

  // 3. Internally integrate viewport fast-track sync (Ticker physical hijacking)
  useTicker(() => {
    const v = volatileRef.current;
    const cam = v.buffered.frames[frame.id]?.camera;
    if (v.activeState.interacting && cam && stageRef.current) {
      Motion.set(stageRef.current, {
        x: cam.x,
        y: cam.y,
        scale: cam.k,
        overwrite: true
      });
    }
  });

  return { isGroomed };
}


/**
 * useOverlayRotationSync: Overlay rotation sync hook (compensating animation protocol)
 * 
 * Background:
 * Viewport (image) rotation in the editor uses a "state instant placement + tween compensation" strategy.
 * If Overlays (e.g., bounding boxes, layer frames) are rendered in Screen Space, they will instantly jump with the state.
 * 
 * Logic:
 * 1. Listen for frame.rotation jump signals (90/180/270 degrees).
 * 2. Calculate the physical pixel position of the current canvas center on the screen as the rotation origin (transformOrigin).
 * 3. In the same frame as the state jump, immediately rotate the container in the opposite direction by delta degrees (swapRotate) so it stays visually in place.
 * 4. Start tweening, rotating container back to 0, achieving silky transition fully synchronized with canvas.
 * 
 * @param ref Overlay container DOM reference (requires container to be absolute inset-0 and pointer-events-none)
 * @param frame Active Frame object (contains camera, canvas, and rotation)
 */
export function useOverlayRotationSync(
  ref: React.RefObject<HTMLElement | null>,
  frame: Frame | null
) {
  const { geometry } = useEditorServices();
  const { isRotationSwap, delta } = useGeometrySync(frame?.rotation ?? 0);

  useLayoutEffect(() => {
    if (!ref.current || !isRotationSwap || !frame) return;

    // 1. Calculate the physical position of the current canvas center on the screen (the rotation axis)
    const cam = frame.camera;
    const center = geometry.space.localToScreen(
      frame.canvas.w / 2,
      frame.canvas.h / 2,
      frame,
      cam
    );

    // 2. Set the rotation axis to absolute screen pixel coordinates
    Motion.set(ref.current, {
      transformOrigin: `${center.x}px ${center.y}px`
    });

    // 3. Execute rigid body rotation compensation animation
    Motion.swapRotate(ref.current, delta);

  }, [ref, frame, isRotationSwap, delta, geometry]);
}
