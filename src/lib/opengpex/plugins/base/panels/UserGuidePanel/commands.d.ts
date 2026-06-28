/**
 * UserGuidePanel/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<UserGuidePanelCommandsMap>() */
export interface UserGuidePanelCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  toggleCmd: CommandInstance;
}

/** Type map for usePluginSignals<UserGuidePanelSignalsMap>() */
export interface UserGuidePanelSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  openSignal: {
    value: boolean;
    set: (val: boolean) => void;
  };
}
