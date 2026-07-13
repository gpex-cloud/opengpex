/**
 * BgRemovalDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index.tsx signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';
import type { BgRemovalStatus } from './protocols';

/** Type map for usePluginCommands<BgRemovalCommandsMap>() */
export interface BgRemovalCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  removeBgCmd: CommandInstance;
  downloadModelCmd: CommandInstance;
  abortCmd: CommandInstance;
  openSettingsCmd: CommandInstance;
}

/** Type map for usePluginSignals<BgRemovalSignalsMap>() */
export interface BgRemovalSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  statusSignal: {
    value: BgRemovalStatus;
    set: (val: BgRemovalStatus) => void;
  };
}
