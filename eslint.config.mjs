import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".open-next/**",
    "public/ext/**",
    "public/hb/**",   // self-built wasm variants (minified emscripten output, plan §12.10)
  ]),
  // Editor library uses <img> for dynamic blob/asset URLs that are incompatible
  // with Next.js Image optimization. Suppress the warning for the editor core.
  {
    files: ["src/lib/opengpex/**/*.{ts,tsx}"],
    rules: {
      "@next/next/no-img-element": "off",
      // Allow _prefixed vars for intentional "omit via destructuring" patterns
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
  // ─── Service boundary enforcement ───────────────────────────────────────────
  // FEATURE layers (plugins, stage interaction, advanced commands) must NOT
  // directly import from internal geometry operator modules: the operator
  // layer is pure math; the "when/why" business decisions live on the
  // services (GeometryService, LayerService — e.g. layers.snap.snapLayerPlacement).
  // Exempt: core/engine (the snap single source holder), core/geometry and
  // core/layer themselves (operator + service implementations).
  {
    files: [
      "src/lib/opengpex/plugins/**/*.{ts,tsx}",
      "src/lib/opengpex/stage/**/*.ts",
      "src/lib/opengpex/core/advanced/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: [
              "@opengpex/editor/core/geometry/operators/*",
              "**/core/geometry/operators/*",
            ],
            message: "Feature layers must not import internal geometry operators directly. Use the injected services instead (geometry.*, layers.snap.* via context or InteractionEvent).",
          },
        ],
      }],
    },
  },
]);

export default eslintConfig;
