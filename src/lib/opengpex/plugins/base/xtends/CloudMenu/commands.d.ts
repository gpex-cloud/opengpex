/**
 * CloudMenu/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>().
 * Generated from commands.ts command declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, Frame } from '@opengpex/editor/core/types';
import type { SaveToCloudPayload, OpenFromCloudPayload } from './commands';
import type { SaveResult } from './protocols';

/** Type map for usePluginCommands<CloudMenuCommandsMap>() */
export interface CloudMenuCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  saveToCloudCmd: CommandInstance<SaveToCloudPayload, Promise<SaveResult>>;
  openFromCloudCmd: CommandInstance<OpenFromCloudPayload, Promise<Frame | null>>;
  deleteFromCloudCmd: CommandInstance<{ fileId: string }, Promise<void>>;
}
