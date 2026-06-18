# User-space Plugin Sandbox

Welcome to the OpenGPEX local plugin development sandbox. This directory is reserved for writing, testing, and debugging your custom plugins locally.

## Features of this Sandbox

1. **Git Ignored**: Any folder you create inside this directory (except this `README.md`) is ignored by Git, ensuring you don't accidentally commit your private or work-in-progress plugins to the main repository.
2. **Auto-Discovery**: The build and development compiler automatically scan this directory on startup. Any valid plugin folder placed here will be dynamically registered into the workspace.

---

## Quick Start: Creating a Local Plugin

We recommend following the **5-File Pattern** to keep your plugin architecture modular and clean:

1. **Create your Plugin Directory**:  
   Create a new folder under this directory (e.g. `src/lib/opengpex/plugins/user/my-custom-plugin/`).

2. **Add the 5 Standard Files**:
   - `protocols.ts`: Define your plugin's unique ID, slots, command names, and parameter types.
   - `index.tsx`: The main plugin entry point. Declare your package, manifest details, targeted slots (e.g. `SIDE_BAR`, `VIEWPORT_OVERLAY`), and register commands/signals.
   - `commands.ts`: Contains the business logic of your plugin (functions triggered by actions).
   - `hooks.ts`: React hook bridges connecting the editor state to your custom plugin logic.
   - `components.tsx`: The UI layout of your plugin (render nodes, option drawers, buttons, overlays).

3. **Start the Development Server**:
   Run the following command at the root of the `opengpex` repository:
   ```bash
   pnpm dev
   ```
   During startup, `scripts/scan-plugins.mjs` will automatically detect your plugin and update `src/lib/opengpex/plugins/registry-user.ts`.

4. **Test in Browser**:
   Open http://localhost:3030 and your custom plugin will be loaded and functional.

---

## Important Rules

- **Auto-Generated Registry**: Do not edit `src/lib/opengpex/plugins/registry-user.ts` manually. It is regenerated on every build or launch.
- **Namespacing**: Prefix your plugin UI component IDs and protocols to avoid naming collisions with base core plugins.
- **Safety**: Custom plugins run within a dedicated `PluginErrorBoundary` sandbox. If your plugin throws an error, it will render an error boundary fallback without crashing the core editor shell or canvas.
