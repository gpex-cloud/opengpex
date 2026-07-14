/**
 * ClipOptions/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';
import type { ClipTool } from './protocols';

/** Type map for usePluginCommands<ClipOptionsCommandsMap>() */
export interface ClipOptionsCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  toggleModeCmd: CommandInstance<void, Promise<void>>;
  clipToolCycleForwardCmd: CommandInstance;
  clipToolCycleBackwardCmd: CommandInstance;
  exitClipModeCmd: CommandInstance;
  peelCommitCmd: CommandInstance<void, Promise<void>>;
  reCanvasToggleCmd: CommandInstance;
  reCanvasApplyCmd: CommandInstance;
  setAspectCmd: CommandInstance<{ aspect: number | undefined }>;
  resetAspectCmd: CommandInstance;
  branchCreateCmd: CommandInstance<{ rect: DOMRect }, Promise<void>>;
  boxResetCmd: CommandInstance<void, Promise<void>>;
  antiAliasToggleCmd: CommandInstance;
  clipToolSetCmd: CommandInstance<{ tool: ClipTool }>;
  drillSelectionCmd: CommandInstance;
  layerViaCopyCmd: CommandInstance;
  layerViaCutCmd: CommandInstance;
  selectFromAlphaCmd: CommandInstance<void, Promise<void>>;
  invertSelectionCmd: CommandInstance;
  offsetSelectionCmd: CommandInstance<{ distance: number }, Promise<void>>;
}

/** Type map for usePluginSignals<ClipOptionsSignalsMap>() */
export interface ClipOptionsSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  reCanvasActiveSignal: {
    value: boolean;
    set: (val: boolean) => void;
  };
  clipFeatherValueSignal: {
    value: number;
    set: (val: number) => void;
  };
}
