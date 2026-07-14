/**
 * FontLoader/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<FontLoaderCommandsMap>() */
export interface FontLoaderCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  loadFontCmd: CommandInstance<{ family: string }, Promise<boolean>>;
}

/** Type map for usePluginSignals<FontLoaderSignalsMap>() */
export interface FontLoaderSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  loadingSignal: {
    value: boolean;
    set: (val: boolean) => void;
  };
}
