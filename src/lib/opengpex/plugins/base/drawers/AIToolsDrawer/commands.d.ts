/**
 * AIToolsDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';
import type { SegEncodePayload, SegEncodeResult, SegDecodePayload, SegDecodeResult } from './protocols';

/** Type map for usePluginCommands<AIToolsDrawerCommandsMap>() */
export interface AIToolsDrawerCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  removeBgCmd: CommandInstance<void, Promise<void>>;
  downloadModelCmd: CommandInstance<void, Promise<void>>;
  abortCmd: CommandInstance<void, Promise<void>>;
  openSettingsCmd: CommandInstance;
  segEncodeCmd: CommandInstance<SegEncodePayload, Promise<SegEncodeResult>>;
  segDecodeCmd: CommandInstance<SegDecodePayload, Promise<SegDecodeResult>>;
  segAllCmd: CommandInstance<void, Promise<void>>;
}

/** Type map for usePluginSignals<AIToolsDrawerSignalsMap>() */
export interface AIToolsDrawerSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  statusSignal: {
    value: unknown;
    set: (val: unknown) => void;
  };
  segStatusSignal: {
    value: unknown;
    set: (val: unknown) => void;
  };
}
