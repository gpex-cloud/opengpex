/**
 * ImageInfoDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>().
 * Generated from commands.ts command declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance } from '@opengpex/editor/core/types';
import type { ExportFormat } from './protocols';

/** Type map for usePluginCommands<ImageInfoDrawerCommandsMap>() */
export interface ImageInfoDrawerCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  downloadCmd: CommandInstance<{ format?: ExportFormat } | void, Promise<void>>;
  downloadOriginalCmd: CommandInstance<void, Promise<void>>;
  applyResizeCmd: CommandInstance<void, Promise<void>>;
}
