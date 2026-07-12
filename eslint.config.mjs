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
  // Plugins and commands must NOT directly import from internal operator modules.
  // They should access functionality via injected services (GeometryService, etc.)
  // See: docs/opengpex/plans/20260712_service_compliance_checklist.md
  {
    files: ["src/lib/opengpex/plugins/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["@opengpex/editor/core/geometry/operators/*"],
            message: "Plugins must not import internal geometry operators directly. Use the GeometryService via context or InteractionEvent instead (e.g. geometry.transform.*, e.geometry.space.*).",
          },
        ],
      }],
    },
  },
]);

export default eslintConfig;
