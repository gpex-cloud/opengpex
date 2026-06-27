# Changelog

All notable changes to OpenGPEX are documented in this file.

---

## v1.0.0-beta.13

- Add selection feather (0–250px edge softening) for masks, drill, layer-via-copy/cut operations
- Add camera RAW format support (CR2, CR3, NEF, ARW, DNG, etc. 1200+ formats) via libraw-wasm client-side decoding
- Improve magic wand selection quality: 4-neighbor BFS to prevent diagonal leakage, morphological closing to fill holes, connected-component filtering, Chaikin curve smoothing
- Reorganize sidebar drawer layout (left/right split), improve AI Bridge drawer UX, add hover glow on drawer bar items

---

## v1.0.0-beta.12

- Add AI background removal plugin (BgRemovalDrawer) with RMBG 1.4 and InSPyReNet models, custom HuggingFace model support, fully client-side inference (WebGPU → WASM fallback)
- Add application-level memory tracker (ResourceTracker) with per-category allocation stats and top-N large object visibility
- Redesign DebugInfoPanel with real-time FPS counter, JS heap metrics, and ResourceTracker integration
- Enhance LayoutInfoPanel and StorageInfoPanel with richer diagnostics
- Refine ClipOverlay interactions and ClipOptions commands

---

## v1.0.0-beta.11

- Add Onboarding plugin with spotlight bubbles and everyday tips guidance system
- Smart paste workflow: auto-create frame when pasting with no canvas, show choice dialog (New Layer / New Frame) when pasting with active frame
- Redesign landing page with animated orbs, mesh grid, and fluid blob accents (pure CSS GPU animations)
- Fix AI Bridge streaming error when calling gpt-image models via litellm gateway

---

## v1.0.0-beta.10

- Add custom cursors for clip tools (rect, ellipse, lasso, wand — each with crosshair + tool badge)
- Implement useClipCursor hook to auto-apply cursor override when clip mode is active
- Add dedicated TOOLTIP z-index (10100) to ensure tooltips always float above popovers
- Add tool identity badge to brush cursor (droplet for brush, × for eraser)
- Add anti-alias (AA) support for lasso and wand tools
- Decouple clip bake from Esc key, rebind to Enter

---

## v1.0.0-beta.9

- Migrate clip tool to per-frame model with independent imageCropBox / irregularCropBoxes per frame
- Simplify core type system (actions, primitives, models, state)
- Consolidate geometry operators (polygon, transform)
- Simplify reducer and useEditorStore with per-frame data flow
- Fix imageCropBox reset on frame create/resize
- Simplify camera init with layout-aware centering

---

## v1.0.0-beta.8

- Clip Polygon Overlay interaction
- Polygon / Lasso crop visualization overlay

---

## v1.0.0-beta.7

- Pinned ToolMenu layout as an icon-only dock with tooltips
- Adjust ToolMenu width to 280px
- Fix viewport camera centering skew when tool menu is pinned

---

## v1.0.0-beta.6

- Preparatory version bump (baseline before workspace layout refactor)

---

## v1.0.0-beta.5

- GIF and BMP format detection support
- HUD notification system (actions.notifyHUD)
- Refactor brush opacity/hardness keyboard shortcuts
- Snap brush size adjustments to multiples of 5

---

## v1.0.0-beta.4

- Optimize ImageInfoDrawer and widget layouts

---

## v1.0.0-beta.3

- SSO cross-site login sync with optimized auth flow UI
- Fix OAuth popup centering relative to browser window

---

## v1.0.0-beta.2

- Fix cloud save/open asset extraction bug

---

## v1.0.0-beta.1

- Editor core architecture (layer system, rendering pipeline, state management)
- Plugin system (base plugin: brush, text, crop, eraser, shapes, etc.)
- Tiled rendering engine with viewport interaction
- Local storage (IndexedDB + localForage)
- File format support: JPEG, PNG, WebP, AVIF, HEIC, PSD, SVG
