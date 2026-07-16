/**
 * ComfyBridgeDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>().
 * Generated from commands.ts command declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<ComfyBridgeDrawerCommandsMap>() */
export interface ComfyBridgeDrawerCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  runWorkflowCmd: CommandInstance<void, Promise<{ success: boolean; promptId?: string; durationMs?: number; error?: string }>>;
  testConnectionCmd: CommandInstance<void, Promise<{ success: boolean; stats?: unknown; error?: string }>>;
  openSettingsCmd: CommandInstance;
}
