/**
 * AIBridgeDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>().
 * Generated from commands.ts command declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance } from '@opengpex/editor/core/types';
import type { AIModelInfo } from './protocols';

/** Type map for usePluginCommands<AIBridgeDrawerCommandsMap>() */
export interface AIBridgeDrawerCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  generateCmd: CommandInstance<void, Promise<{ success: boolean; seed?: number; error?: string }>>;
  fetchModelsCmd: CommandInstance<void, Promise<{ success: boolean; models?: AIModelInfo[]; error?: string }>>;
  openSettingsCmd: CommandInstance;
}
