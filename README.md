<p align="center">
  <img src="public/logo.svg" width="80" height="80" alt="OpenGPEX Logo" />
</p>

<h1 align="center">OpenGPEX</h1>

<p align="center">
  <strong>Industrial-grade, high-performance Graphics and Photo Editor.</strong><br/>
  Non-destructive editing · Tiled rendering · Plugin extensible · Runs entirely in the browser.
</p>

<p align="center">
  ⚠️ <strong>Project Status: Beta</strong> — Core editing features are functional and developer-tested, but the project has not yet undergone broad user testing. Some advanced capabilities may be unstable. Issues and PRs are welcome!
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="https://gpex.cloud">Launch App</a> ·
  <a href="https://gpex.cloud/docs">Documentation</a> ·
  <a href="#plugin-system">Plugins</a>
</p>

---

## What is OpenGPEX?

OpenGPEX is an open-source graphics and photo editor built to tackle high-resolution images and complex multi-layer workflows entirely in the browser. Its architecture is designed from the ground up for scalability — with a tiled rendering pipeline, non-destructive editing core, and plugin-driven extensibility already in place. Think of it as a professional desktop editor's philosophy, delivered as a web application.

### Key Features

| Feature                    | Description                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 🚀 **Tiled Rendering**     | Chunked image processing with Mipmap pyramids + Web Worker synthesis via OffscreenCanvas. No more OOM errors. |
| ⚡ **60FPS Interactions**  | Dual-track state: high-frequency operations (pan/zoom) bypass React VDOM entirely.                            |
| 🕰️ **TimeTravel Undo**     | Incremental undo via Immer JSON Patches — near-zero memory overhead per history step.                         |
| 🛡️ **Non-Destructive CAS** | Original pixels are immutably stored (SHA-256 Content-Addressable Storage). Edits are pure math.              |
| 🧩 **Plugin System**       | Metadata-driven registry with overlays, drawers, options, and backstage slots.                                |
| ☁️ **Cloud Ready**         | Optional cloud sync via [GPEX Cloud](https://gpex.cloud) — save, load, share across devices.                  |

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/gpex-cloud/opengpex.git
cd opengpex

# Install dependencies
pnpm install

# Start dev server
pnpm dev
```

Open **http://localhost:3030** — drag an image in to start editing.

### Build for Production

```bash
pnpm build
pnpm start
```

---

## Tech Stack

- **Framework:** Next.js 16 · React 19
- **State:** Immer + custom store with fast-track mutable refs
- **Styling:** Tailwind CSS v4
- **Rendering:** OffscreenCanvas + Web Workers + WASM (AVIF)
- **Animation:** Framer Motion · GSAP

---

## Plugin System

OpenGPEX is built around an extensible plugin architecture. Every tool, panel, and overlay is a plugin.

```
plugins/
├── base/         # Official plugins (shipped with OpenGPEX)
├── community/    # Community-contributed plugins
└── user/         # Local development sandbox
```

Third-party plugins can be installed at runtime by uploading ZIP packages through the Plugin Hub. See the [Plugin Development Guide](https://gpex.cloud/docs/plugin-development) to get started.

---

## Documentation

Full documentation including architecture guides, plugin development tutorials, and API references is available at:

**📖 [gpex.cloud/docs](https://gpex.cloud/docs)**

---

## Contributing

Contributions are welcome! Please open an issue to discuss your idea before submitting a PR.

---

## Third-party Models

The AI background removal feature downloads pre-trained models at runtime from HuggingFace. These models are **not bundled** with this project and are subject to their own licenses.

| Model | Source | License |
|-------|--------|---------|
| RMBG 1.4 | [briaai/RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) | BRIA RMBG-1.4 (non-commercial) |
| InSPyReNet Ultra | [OS-Software/InSPyReNet-SwinB-Plus-Ultra-ONNX](https://huggingface.co/OS-Software/InSPyReNet-SwinB-Plus-Ultra-ONNX) | MIT |

Users may also add custom HuggingFace models. Please verify the license of any model you use.

---

## Plugin Licensing

OpenGPEX is licensed under GPL-3.0-only. However, third-party plugins loaded dynamically at runtime are considered independent works and may use any license chosen by their authors. Plugins shipped directly in the source tree are covered by the same GPL-3.0 license.

---

## License

Copyright (C) 2026 The OpenGPEX Authors

This program is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License v3.0](./LICENSE) as published by the Free Software Foundation.
