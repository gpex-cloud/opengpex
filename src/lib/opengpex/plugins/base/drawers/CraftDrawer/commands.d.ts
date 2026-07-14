/**
 * CraftDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';
import type { CraftType } from './protocols';

/** Type map for usePluginCommands<CraftDrawerCommandsMap>() */
export interface CraftDrawerCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  setCraftCmd: CommandInstance<{ craft: CraftType }>;
  setCraftTextCmd: CommandInstance;
  setCraftBrushCmd: CommandInstance;
  setCraftEraserCmd: CommandInstance;
  deactivateCraftCmd: CommandInstance;
  brushSizeDownCmd: CommandInstance;
}

/** Type map for usePluginSignals<CraftDrawerSignalsMap>() */
export interface CraftDrawerSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  activeCraftSignal: {
    value: unknown;
    set: (val: unknown) => void;
  };
}
