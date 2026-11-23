/**
 * RetouchOverlay/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>().
 * Generated from commands.ts command declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, Layer } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<RetouchOverlayCommandsMap>() */
export interface RetouchOverlayCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  bakeCmd: CommandInstance<{ frameId: string; layer: Layer; isNew: boolean }>;
}
