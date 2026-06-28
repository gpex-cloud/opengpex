/**
 * TabDock/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>().
 * Generated from commands.ts command declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance } from '@opengpex/editor/core/types';
import type { TabDockConfig } from './protocols';

/** Type map for usePluginCommands<TabDockCommandsMap>() */
export interface TabDockCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  configUpdateCmd: CommandInstance<Partial<TabDockConfig>>;
  navNextCmd: CommandInstance;
  navPrevCmd: CommandInstance;
  openSettingsCmd: CommandInstance;
}
