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
 * names were modernized.
 *
 * @module core/gpu/graph/SceneCompiler
 */

import type { Scene, LayerNode, EffectStageDesc } from '../scene/Scene';
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

/**
 * External-effect kinds whose pixels blend against the canvas BACKDROP
 * (beneath the layer content). Phase 1 covers Drop Shadow and Outer Glow;
 * Stroke (outside/center) joins in a later phase.
 */
/** The shadow / outer-glow union members (the Phase-1 external kinds). */
type ExternalEffectStage =
  | Extract<EffectStageDesc, { kind: 'shadow' }>
  | Extract<EffectStageDesc, { kind: 'outer-glow' }>;

function isExternalEffectStage(stage: EffectStageDesc): stage is ExternalEffectStage {
  return stage.kind === 'shadow' || stage.kind === 'outer-glow';
}

/**
 * Split ONE layer's external effect stages into standalone composite
 * `LayerNode`s (bottom-to-top z-order), or return `null` when the layer has
 * no external effect with a backdrop blend (the flat single-transient fast
 * path stays).
 *
 * Z-ORDER CONTRACT: `layer.effects` is already in render-evaluation order
 * (the translator sorts by category rank: shadows first, then outer glows).
 * Within one category, instance [0] stacks ON TOP of instance [1] (each
 * later flat compose lands BENEATH the accumulated foreground), so the
 * bottom-to-top emission order is each category slice REVERSED: shadows
 * reversed, then outer glows reversed — identical stacking to the Class-A
 * flattening.
 *
 * Each split node is a lightweight synthetic layer: geometry fields are
 * shallow-copied from the owner (the actual draw rect comes from the
 * standalone `PreparedSource`'s `contentWindow` + `expandQuadToWindow`),
 * `blendMode` is the stage's own backdrop blend, and every content-mutating
 * field (effects / adjustStages / masks) is left empty — the pixels live in
 * the `sources` map under the synthetic id `${layer.id}::eff:${stageIndex}`,
 * where stageIndex is the stage's index in `layer.effects`.
 */
export function splitExternalEffectLayer(layer: LayerNode): readonly LayerNode[] | null {
  const effects = layer.effects;
  if (!effects || effects.length === 0) return null;
  let backdropBlends = false;
  for (const stage of effects) {
    if (isExternalEffectStage(stage) && (stage.blendMode ?? 'source-over') !== 'source-over') {
      backdropBlends = true;
      break;
    }
  }
  if (!backdropBlends) return null;

  const shadowIndices: number[] = [];
  const glowIndices: number[] = [];
  effects.forEach((stage, index) => {
    if (stage.kind === 'shadow') shadowIndices.push(index);
    else if (stage.kind === 'outer-glow') glowIndices.push(index);
  });
  // Bottom-to-top: each category slice reversed (instance [0] ends up drawn
  // last among its family), shadows beneath glows (the category ranks).
  const orderedIndices = [...shadowIndices.reverse(), ...glowIndices.reverse()];
  return orderedIndices.map((stageIndex) => {
    // Only shadow / outer-glow indices enter `orderedIndices` above.
    const stage = effects[stageIndex] as ExternalEffectStage;
    return {
      id: `${layer.id}::eff:${stageIndex}`,
      source: layer.source,
      transform: layer.transform,
      width: layer.width,
      height: layer.height,
      crop: layer.crop,
      dprScale: layer.dprScale,
      clip: layer.clip,
      opacity: layer.opacity,
      // The stage's OWN backdrop blend — the owner layer's blendMode must
      // not leak onto an effect step (PS semantics: independent).
      blendMode: stage.blendMode ?? 'source-over',
    };
  });
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

    /** Feed one draw node into the shared hardware-blendable batching. */
    const emitNode = (node: LayerNode) => {
      if (isHardwareBlendable(node.blendMode)) {
        currentSeparable.push(node);
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
          layer: node,
        });
      }
    };

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      // CLASS-B SPLIT: any external effect with a backdrop blend promotes
      // EVERY external effect of the layer to its own composite step (a
      // source-over shadow flattened into the body would paint OVER a
      // Screen glow stacked above it). Effect steps first (beneath), then
      // the body. All nodes — synthetic effects and the owner alike — go
      // through the SAME batching with no special cases.
      const effectNodes = splitExternalEffectLayer(layer);
      if (effectNodes) {
        for (const node of effectNodes) emitNode(node);
        emitNode(layer);
        continue;
      }
      emitNode(layer);
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
