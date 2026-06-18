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
 * Motion Presets Library
 * Unified management of physical tween parameters in the editor.
 */
export const MOTION_PRESETS = {
  /**
   * Classic Handfeel (Classic): 1.1s / power3.out
   * Rotation starts fast and ends extremely slowly, having a strong aesthetic of inertia.
   */
  CLASSIC: {
    duration: 1.1,
    ease: 'power3.out',
    overwrite: 'auto'
  },

  /**
   * Snappy Response (Snappy): 0.4s / power4.out
   * Clean and crisp, no lagging, suitable for expert mode aiming for efficiency.
   */
  SNAPPY: {
    duration: 0.4,
    ease: 'power4.out',
    overwrite: 'auto'
  },

  /**
   * Bouncy Rebound (Bouncy): 0.8s / back.out(1.7)
   * Has a physical rebound feel, adding emotional value to the interaction.
   */
  BOUNCY: {
    duration: 0.8,
    ease: 'back.out(1.7)',
    overwrite: 'auto'
  },

  /**
   * Extremely Soft (Soft): 1.5s / expo.out
   * Smooth and slow like satin, suitable for slow-paced creative presentations.
   */
  SOFT: {
    duration: 1.5,
    ease: 'expo.out',
    overwrite: 'auto'
  }
} as const;

export type MotionPresetName = keyof typeof MOTION_PRESETS;

/**
 * Default transform animation configuration (maintains CLASSIC to guarantee backward compatibility)
 */
export const DEFAULT_TRANSFORM_ANIMATION = MOTION_PRESETS.CLASSIC;
