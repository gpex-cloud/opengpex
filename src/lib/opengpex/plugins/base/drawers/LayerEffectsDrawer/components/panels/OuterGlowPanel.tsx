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
 * OuterGlowPanel — the outer-glow effect's parameter rows: color swatch,
 * blur (Gaussian sigma), spread (silhouette dilation before the blur) and
 * strength, all on the SAME fast channel as the stroke/shadow/color-overlay
 * panels: pointerdown opens ONE undoable checkpoint (`beginEffectEdit`),
 * every drag move parks the full OuterGlowParams on the volatile buffer
 * (`fastUpdateEffectParams` → `fast.overrideLayer`), and pointerup lands ONE
 * Redux write (`commitEffectParams`) — the whole drag is exactly one Undo
 * step.
 *
 * NO blend-mode parameter, by product ruling: the reference product's
 * Outer Glow default Screen brightening is approximated layer-internally in
 * the render pipeline (a bright glow colour composed beneath the content),
 * so there is nothing for a blend-mode dropdown to select.
 *
 * Template contract inherited from ShadowPanel: own your fast mirrors
 * locally, write through the shared commands, keep the gesture lifecycle
 * (including the unmount commit) intact.
 */

import React, { useState } from 'react';
import ColorSwatchRow from '@opengpex/editor/widgets/ColorSwatchRow';
import FancySvgSlider from '@opengpex/editor/widgets/FancySvgSlider';
import type { EffectInstance, Layer, OuterGlowParams } from '@opengpex/editor/core/types/models';
import { updateEffectParams } from '@opengpex/editor/core/layer/effects';
import { usePluginCommands } from '@opengpex/editor/core/context';
import { useFilterGesture } from '@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/hooks';
import type { LayerEffectsDrawerCommandsMap } from '../../commands.d';
import { PanelSection } from './shared';

export function OuterGlowPanel({
  layer,
  instance,
}: {
  layer: Layer;
  instance: EffectInstance;
}) {
  const {
    beginEffectEditCmd,
    fastUpdateEffectCmd,
    commitEffectCmd,
    applyEffectPatchCmd,
  } = usePluginCommands<LayerEffectsDrawerCommandsMap>();
  const gesture = useFilterGesture(beginEffectEditCmd);

  const params = instance.params as OuterGlowParams;

  // Fast-drag mirrors: while a drag runs, the store stays frozen until the
  // gesture's single commit, so the controls feed from THIS local state.
  const [fastColor, setFastColor] = useState<OuterGlowParams['color'] | null>(null);
  const [fastBlur, setFastBlur] = useState<number | null>(null);
  const [fastSpread, setFastSpread] = useState<number | null>(null);
  const [fastStrength, setFastStrength] = useState<number | null>(null);

  // Shared fast write: full OuterGlowParams against the freshest draft.
  const fastWrite = (next: OuterGlowParams) => {
    fastUpdateEffectCmd?.execute({ instanceId: instance.id, params: next });
  };

  const applyOneShot = (next: OuterGlowParams) => {
    const patch = updateEffectParams(layer, instance.id, next);
    if (patch) applyEffectPatchCmd?.execute({ patch });
  };

  /**
   * One fast channel per numeric param — the identical four-piece contract
   * (checkpoint at drag start, volatile park per move, ONE Redux write at
   * drag end, one-shot mini gesture for typed commits) shared by every
   * scalar row; only the param key and its fast mirror differ.
   */
  const bindNumericParam = (
    key: keyof OuterGlowParams,
    setFast: (v: number | null) => void,
  ) => ({
    onDragStart: () => {
      gesture.begin();
    },
    onChange: (value: number) => {
      const next = { ...params, [key]: value } as OuterGlowParams;
      if (fastUpdateEffectCmd && commitEffectCmd) {
        fastWrite(next);
        setFast(value);
        return;
      }
      applyOneShot(next);
      setFast(value);
    },
    onDragEnd: () => {
      if (!gesture.isDragging()) return;
      // Scalar sliders quantize while dragging — the last fast write already
      // holds the exact value; land ONE Redux write.
      commitEffectCmd?.execute();
      setFast(null);
      gesture.end();
    },
    onFieldCommit: (value: number) => {
      // Typed-value commit is a ONE-SHOT write in a mini gesture.
      gesture.begin();
      applyOneShot({ ...params, [key]: value } as OuterGlowParams);
      gesture.end();
    },
  });

  const blurChannel = bindNumericParam('blurRadius', setFastBlur);
  const spreadChannel = bindNumericParam('spreadPx', setFastSpread);
  const strengthChannel = bindNumericParam('strength', setFastStrength);

  // ─── Color ─────────────────────────────────────────────────────────────
  const handleColorChange = (color: OuterGlowParams['color']) => {
    gesture.begin();
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
      setFastColor(color);
      return;
    }
    applyOneShot({ ...params, color });
    setFastColor(color);
  };

  const handleColorCommit = (color: OuterGlowParams['color']) => {
    if (!gesture.isDragging()) return;
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
    }
    commitEffectCmd?.execute();
    setFastColor(null);
    gesture.end();
  };


  // A drag interrupted by unmount must still land its volatile draft — the
  // same cleanup contract as the stroke/shadow/color-overlay panels.
  React.useEffect(() => {
    return () => {
      if (gesture.isDragging()) {
        commitEffectCmd?.execute();
        setFastColor(null);
        setFastBlur(null);
        setFastSpread(null);
        setFastStrength(null);
        gesture.end();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-3 px-3 pt-2 pb-3">
      {/* Single-row layout: the label sits inline LEFT of the swatch control
          (ColorSwatchRow's built-in label — the house row pattern). The
          trailing reset restores this category's factory defaults with ONE
          undoable patch (no fast buffer — a discrete action, not a drag). */}
      <div className="flex items-center gap-1">
        <ColorSwatchRow
          label="Color"
          className="px-0"
          labelClassName="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0"
          value={fastColor ?? params.color}
          onValueChange={handleColorChange}
          onValueCommit={handleColorCommit}
        />
      </div>
      <PanelSection label="Blur">
        {/* The unit sits inline after the slider's numeric field (house
            pattern). UI range 0..50 px — the translator clamps the same
            bounds. */}
        <div className="flex items-center gap-1">
          <FancySvgSlider
            className="flex-1"
            value={fastBlur ?? params.blurRadius}
            min={0}
            max={50}
            step={1}
            precision={0}
            slim
            withInput
            ariaLabel="Outer glow blur"
            {...blurChannel}
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
        </div>
      </PanelSection>
      <PanelSection label="Spread">
        {/* Silhouette dilation before the blur — grows the halo WITHOUT
            softening it. The glow's Spread has no negative range: 0..50 px. */}
        <div className="flex items-center gap-1">
          <FancySvgSlider
            className="flex-1"
            value={fastSpread ?? params.spreadPx ?? 0}
            min={0}
            max={50}
            step={1}
            precision={0}
            slim
            withInput
            ariaLabel="Outer glow spread"
            {...spreadChannel}
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
        </div>
      </PanelSection>
      <PanelSection label="Strength">
        <FancySvgSlider
          value={fastStrength ?? params.strength ?? 1}
          min={0}
          max={1}
          step={0.01}
          precision={2}
          slim
          withInput
          ariaLabel="Outer glow strength"
          {...strengthChannel}
        />
      </PanelSection>
    </div>
  );
}
