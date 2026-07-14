/**
 * Onboarding/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>().
 * Generated from commands.ts command declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<OnboardingCommandsMap>() */
export interface OnboardingCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  dismissSpotlightCmd: CommandInstance;
  dismissTipsCmd: CommandInstance;
  resetOnboardingCmd: CommandInstance;
}
