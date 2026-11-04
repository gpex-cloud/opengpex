/**
 * ClipOverlay/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>().
 * Generated from commands.ts command declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, TransformParams } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<ClipOverlayCommandsMap>() */
export interface ClipOverlayCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  peelExchangeCmd: CommandInstance<{ isCopy: boolean }, Promise<void>>;
  peelDiscardCmd: CommandInstance;
  peelMergeCmd: CommandInstance<void, Promise<boolean>>;
  peelApplyTransformCmd: CommandInstance<{ pose: TransformParams }, Promise<void>>;
  peelResetTransformCmd: CommandInstance;
  peelSettleCmd: CommandInstance<{ mode: 'commit' | 'discard' }, Promise<boolean>>;
}
