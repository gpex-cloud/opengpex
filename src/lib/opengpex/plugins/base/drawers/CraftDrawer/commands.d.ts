/**
 * CraftDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index.tsx signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';
import type { CraftType, ActiveCraft } from './protocols';

/** Type map for usePluginCommands<CraftCommandsMap>() */
export interface CraftCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  setCraftCmd: CommandInstance<{ craft: CraftType }>;
  setCraftTextCmd: CommandInstance;
  setCraftBrushCmd: CommandInstance;
  setCraftEraserCmd: CommandInstance;
  deactivateCraftCmd: CommandInstance;
  craftSizeUpCmd: CommandInstance;
  craftSizeDownCmd: CommandInstance;
  brushOpacityUpCmd: CommandInstance;
  brushOpacityDownCmd: CommandInstance;
  brushHardnessUpCmd: CommandInstance;
  brushHardnessDownCmd: CommandInstance;
}

/** Type map for usePluginSignals<CraftSignalsMap>() */
export interface CraftSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  activeCraftSignal: {
    value: ActiveCraft;
    set: (val: ActiveCraft) => void;
  };
}
