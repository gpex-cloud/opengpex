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

import gsap from 'gsap';
import { MOTION_PRESETS, MotionPresetName, DEFAULT_TRANSFORM_ANIMATION } from './constants';

export type MotionVars = gsap.TweenVars;

/**
 * Internal State: Currently active transform configuration
 */
let _activeConfig: gsap.TweenVars = { ...DEFAULT_TRANSFORM_ANIMATION };

/**
 * Motion: Single abstract entry point of the editor animation system (The Animation Facade)
 */
export const Motion = {
  /**
   * Animation preset library: exposed for external query
   */
  PRESETS: MOTION_PRESETS,

  /**
   * Animation tempo constants: ensures consistency across all animations (UI general durations)
   */
  DURATIONS: {
    FAST: 0.2,
    NORMAL: 0.4,
    SLOW: 0.8,
    TRANSFORM: 1.1,
  },

  /**
   * Switch global preset feel
   * @param name Preset name (CLASSIC | SNAPPY | BOUNCY | SOFT)
   */
  usePreset(name: MotionPresetName) {
    if (MOTION_PRESETS[name]) {
      _activeConfig = { ...MOTION_PRESETS[name] };
    }
  },

  /**
   * Get currently active transform configuration
   */
  getCurrentConfig(): gsap.TweenVars {
    return _activeConfig;
  },

  /**
   * Basic tween animation
   * Logic: merges current global configuration with incoming custom variables
   */
  to(target: gsap.TweenTarget, vars: gsap.TweenVars) {
    return gsap.to(target, {
      ..._activeConfig,
      ...vars,
    });
  },

  /**
   * Instant state setting
   * Industrial-grade enhancement: defaults to overwrite: 'auto' to ensure "rigid body sync" can instantly interrupt any conflicting tween animations.
   */
  set(target: gsap.TweenTarget, vars: gsap.TweenVars) {
    return gsap.set(target, { ...vars, overwrite: 'auto' });
  },

  /**
   * Range tween
   */
  fromTo(target: gsap.TweenTarget, from: gsap.TweenVars, to: gsap.TweenVars) {
    return gsap.fromTo(target, from, {
      ..._activeConfig,
      ...to,
    });
  },

  /**
   * Create timeline
   */
  timeline(vars?: gsap.TimelineVars) {
    return gsap.timeline(vars);
  },

  /**
   * Delayed call
   */
  delayedCall(delay: number, callback: (...args: unknown[]) => void) {
    return gsap.delayedCall(delay, callback);
  },

  /**
   * Kill tweens of a specific target
   */
  killTweensOf(target: gsap.TweenTarget) {
    return gsap.killTweensOf(target);
  },

  /**
   * Execute rotation compensation animation (core of the sync protocol)
   */
  swapRotate(target: gsap.TweenTarget, delta: number, vars: gsap.TweenVars = {}) {
    return gsap.fromTo(target,
      { rotation: -delta },
      {
        rotation: 0,
        ..._activeConfig,
        ...vars,
        overwrite: 'auto'
      }
    );
  },

  /**
   * syncViewportGeometry: Industrial-grade viewport geometry sync protocol
   * Decouples complex animation decisions from the Viewport component to the physical engine layer
   */
  syncViewportGeometry(params: {
    stage: HTMLElement | null,
    artboard: HTMLElement | null,
    current: { x: number, y: number, k: number, w: number, h: number, rotation: number, id: string },
    prev: { k: number, id: string, w: number, h: number },
    interaction: { isInteracting: boolean, rotationChanged: boolean, isRotationSwap: boolean, delta: number },
    onGroomed?: () => void
  }) {
    const { stage, artboard, current, prev, interaction, onGroomed } = params;
    if (!stage || !artboard || interaction.isInteracting) return;

    const isInitialLoad = prev.k === 0;
    const frameIdChanged = prev.id !== current.id;
    const { x, y, k } = current;
    const { w, h } = current;

    if (frameIdChanged || isInitialLoad) {
      // Strategy A: Bootstrapping/switching flow (Bootstrap) -> rapid placement and instant signal release
      // If switching Frame, we no longer wait for 0.45s animation, but display immediately or use a very short fade-in
      this.set(artboard, { width: w, height: h, rotation: 0 });
      this.fromTo(stage,
        { opacity: 0, x, y, scale: k || 1 }, // Fallback k to 1
        {
          opacity: 1,
          duration: isInitialLoad ? 0.4 : 0.15, // 0.15s only when switching
          ease: 'power2.out',
          overwrite: 'auto',
          onStart: onGroomed, // release signal as soon as animation starts, do not wait for completion
          onComplete: onGroomed // double insurance
        }
      );
    } else {
      // Strategy B: Update flow (Updates)
      onGroomed?.(); // ensure all paths trigger the signal
      const sizeChanged = w !== prev.w || h !== prev.h;

      if (sizeChanged && !interaction.isRotationSwap) {
        // Strategy B-1: structural change (Reshape/Crop) -> instant fade-in compensation
        this.set(stage, { x, y, scale: k });
        this.set(artboard, { width: w, height: h });
        this.fromTo(stage, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power2.inOut', overwrite: 'auto' });
      } else {
        // Strategy B-2: motion sync (Motion Sync)
        const config = interaction.rotationChanged ? {} : { duration: 0.15, ease: 'power2.out' };

        if (interaction.isRotationSwap) {
          // Rigid body rotation compensation
          this.set(stage, { x, y, scale: k });
          this.set(artboard, { width: w, height: h });
          this.swapRotate(artboard, interaction.delta, config);
        } else {
          // Fluid motion (Pan/Zoom)
          this.to(stage, { x, y, scale: k, ...config, overwrite: 'auto' });

          if (interaction.rotationChanged) {
            this.to(artboard, { width: w, height: h, ...config });
            this.swapRotate(artboard, interaction.delta, config);
          }
        }
      }
    }
  },

  /**
   * Global clock handle
   */
  ticker: gsap.ticker,
};
