/**
 * BrushOverlay/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue, Layer } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<BrushOverlayCommandsMap>() */
export interface BrushOverlayCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  bakeCmd: CommandInstance<{ frameId: string; layer: Layer; isNew: boolean }>;
}

/** Type map for usePluginSignals<BrushOverlaySignalsMap>() */
export interface BrushOverlaySignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  isStrokingSignal: {
    value: boolean;
    set: (val: boolean) => void;
  };
}
