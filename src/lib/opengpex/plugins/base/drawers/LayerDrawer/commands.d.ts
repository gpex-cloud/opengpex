/**
 * LayerDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>().
 * Generated from commands.ts command declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<LayerDrawerCommandsMap>() */
export interface LayerDrawerCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  reorderCmd: CommandInstance<{ frameId: string; layers: Layer[] }>;
  removeCmd: CommandInstance<{ frameId?: string; layerId?: string }>;
  visibilityCmd: CommandInstance<{ frameId?: string; layerId: string; visible: boolean }>;
  lockCmd: CommandInstance<{ frameId?: string; layerId: string; locked: boolean }>;
  renameCmd: CommandInstance<{ frameId?: string; layerId: string; name: string }>;
  syncOverlayCmd: CommandInstance<{ frameId?: string; layerId: string }>;
  syncMaskCmd: CommandInstance<{ frameId?: string; layerId: string; maskId: string }>;
}
