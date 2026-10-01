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
 * SceneCompiler.ts — Decomposes Scene layers into execution batches.
 *
 * Consecutive hardware-blendable layers (class A — currently only `source-over`,
 * see `isHardwareBlendable`) are merged into a single RenderPass batch
 * (`HardwareBlendableBatch`). All other modes (multiply, screen, darken, lighten,
 * overlay, HSL, …) are class B and each produces an isolated ping-pong step
 * (`PingPongStep`).
 *
 * NOTE: the `kind` discriminants (`'separable'` / `'non-separable'`) are kept as
 * stable string literals to preserve RenderGraph behavior; only the interface
 * names were modernized in WP-5.9.
 *
 * @module core/gpu/graph/SceneCompiler
 */

import type { Scene, LayerNode } from '../scene/Scene';
import { isHardwareBlendable } from '@opengpex/editor/core/engine/gpu/shaders/blend';

export interface HardwareBlendableBatch {
  readonly kind: 'separable';
  readonly layers: readonly LayerNode[];
}

export interface PingPongStep {
  readonly kind: 'non-separable';
  readonly layer: LayerNode;
}

export type ExecutionStep = HardwareBlendableBatch | PingPongStep;

export interface CompiledScene {
  readonly scene: Scene;
  readonly steps: readonly ExecutionStep[];
  /**
   * True if the scene contains exclusively separable layers and can render
   * straight onto the swapchain in a single pass without transient ping-pong textures.
   */
  readonly isPureDirect: boolean;
}

export class SceneCompiler {
  /**
   * Compile a declarative Scene into an execution plan.
   */
  static compile(scene: Scene): CompiledScene {
    const layers = scene.layers;
    if (layers.length === 0) {
      return {
        scene,
        steps: [],
        isPureDirect: true,
      };
    }

    const steps: ExecutionStep[] = [];
    let currentSeparable: LayerNode[] = [];
    let hasNonSeparable = false;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (isHardwareBlendable(layer.blendMode)) {
        currentSeparable.push(layer);
      } else {
        hasNonSeparable = true;
        if (currentSeparable.length > 0) {
          steps.push({
            kind: 'separable',
            layers: currentSeparable,
          });
          currentSeparable = [];
        }
        steps.push({
          kind: 'non-separable',
          layer,
        });
      }
    }

    if (currentSeparable.length > 0) {
      steps.push({
        kind: 'separable',
        layers: currentSeparable,
      });
    }

    return {
      scene,
      steps,
      isPureDirect: !hasNonSeparable,
    };
  }
}
