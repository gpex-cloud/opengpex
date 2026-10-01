/**
 * ColorOptions/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';
import type { ColorValue } from '@opengpex/editor/core/engine/color';
import type { SamplerTool } from './protocols';

/** Type map for usePluginCommands<ColorOptionsCommandsMap>() */
export interface ColorOptionsCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  fillAsLayerCmd: CommandInstance<{ fillColor: ColorValue }>;
  sampleColorCmd: CommandInstance;
  samplerToolSetCmd: CommandInstance<{ tool: SamplerTool }>;
  samplerToolCycleForwardCmd: CommandInstance;
  samplerToolCycleBackwardCmd: CommandInstance;
  exitSamplerCmd: CommandInstance;
}

/** Type map for usePluginSignals<ColorOptionsSignalsMap>() */
export interface ColorOptionsSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  samplerActiveSignal: {
    value: boolean;
    set: (val: boolean) => void;
  };
}
