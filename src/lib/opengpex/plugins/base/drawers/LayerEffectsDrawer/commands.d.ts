/**
 * LayerEffectsDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';
import type { EffectCategory, StrokeParams, ShadowParams, ColorOverlayParams, OuterGlowParams, GradientOverlayParams, InnerGlowParams, InnerShadowParams, Layer } from '@opengpex/editor/core/types/models';

/** Type map for usePluginCommands<LayerEffectsDrawerCommandsMap>() */
export interface LayerEffectsDrawerCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  beginEffectEditCmd: CommandInstance;
  fastUpdateEffectCmd: CommandInstance<{ instanceId: string; category: EffectCategory; params: StrokeParams | ShadowParams | ColorOverlayParams | OuterGlowParams | GradientOverlayParams | InnerGlowParams | InnerShadowParams }>;
  commitEffectCmd: CommandInstance;
  applyEffectPatchCmd: CommandInstance<{ patch: Partial<Layer> }>;
  removeEffectInstanceCmd: CommandInstance<{ instanceId: string }>;
  openEffectInstancePanelCmd: CommandInstance<{ instanceId: string }>;
}

/** Type map for usePluginSignals<LayerEffectsDrawerSignalsMap>() */
export interface LayerEffectsDrawerSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  activeEffectInstanceSignal: {
    value: unknown;
    set: (val: unknown) => void;
  };
}
