/**
 * AdjustmentDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>().
 * Generated from commands.ts command declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<AdjustmentCommandsMap>() */
export interface AdjustmentCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  updateCmd: CommandInstance<{ key: string; value: number }>;
  beginEditCmd: CommandInstance;
  resetCmd: CommandInstance;
}
